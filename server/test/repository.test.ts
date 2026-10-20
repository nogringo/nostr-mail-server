import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { migrate } from '../src/migrations.js'
import { PgDomainRepository } from '../src/repository.js'
import type { DomainChecks, NewDomain } from '../src/types.js'

// Runs against a real Postgres when TEST_DATABASE_URL is set, inside a
// throwaway schema.
const databaseUrl = process.env.TEST_DATABASE_URL

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

const checks: DomainChecks = {
  ownership: { status: 'ok', found: ['nostr-mail-verification=t'] },
  mx: { status: 'missing', found: [] },
  spf: { status: 'missing', found: [] },
  dkim: { status: 'missing', found: [] },
  dmarc: { status: 'missing', found: [] },
}

function claim(domain: string, pubkey: string): NewDomain {
  return {
    domain,
    pubkey,
    verificationToken: randomBytes(4).toString('hex'),
    dkimSelector: 'nostrmail',
    dkimPublicKey: 'public',
    dkimPrivateKey: 'private',
  }
}

test('PgDomainRepository', { skip: !databaseUrl && 'TEST_DATABASE_URL is not set' }, async (t) => {
  const schema = `test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: databaseUrl })
  await admin.connect()
  await admin.query(`create schema ${schema}`)

  const url = new URL(databaseUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const repo = new PgDomainRepository(url.toString())

  t.after(async () => {
    await repo.close()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  })

  assert.deepEqual(await migrate(url.toString()), ['001_create_domains.sql'])
  assert.deepEqual(await migrate(url.toString()), [])

  await t.test('creates a claim once per key', async () => {
    const created = await repo.createDomain(claim('example.com', ALICE))
    const again = await repo.createDomain(claim('example.com', ALICE))

    assert.equal(again.verificationToken, created.verificationToken)
    assert.equal(created.verifiedAt, null)
    assert.deepEqual(await repo.findDomain('example.com', ALICE), created)
  })

  await t.test('lists the claims of a key', async () => {
    await repo.createDomain(claim('a.example', ALICE))
    await repo.createDomain(claim('example.com', BOB))

    assert.deepEqual(
      (await repo.listDomains(ALICE)).map((domain) => domain.domain),
      ['a.example', 'example.com'],
    )
  })

  await t.test('records checks without verifying', async () => {
    const updated = await repo.recordChecks('example.com', BOB, { ...checks, ownership: { status: 'missing', found: [] } }, false)

    assert.equal(updated?.verifiedAt, null)
    assert.ok(updated?.checkedAt)
    assert.equal(updated?.checks?.ownership.status, 'missing')
    assert.ok(await repo.findDomain('example.com', ALICE))
  })

  await t.test('verifying drops the other claims and keeps the first verification time', async () => {
    const verified = await repo.recordChecks('example.com', ALICE, checks, true)
    assert.ok(verified?.verifiedAt)
    assert.deepEqual(verified?.checks, checks)
    assert.equal(await repo.findDomain('example.com', BOB), null)

    const rechecked = await repo.recordChecks('example.com', ALICE, checks, true)
    assert.equal(rechecked?.verifiedAt, verified?.verifiedAt)
  })

  await t.test('a domain has at most one verified owner', async () => {
    await repo.createDomain(claim('example.com', BOB))
    await assert.rejects(
      admin.query(`update ${schema}.domains set verified_at = now() where domain = 'example.com' and pubkey = $1`, [BOB]),
      /domains_one_verified_owner/,
    )
  })

  await t.test('deletes a claim', async () => {
    assert.equal(await repo.deleteDomain('a.example', ALICE), true)
    assert.equal(await repo.deleteDomain('a.example', ALICE), false)
    assert.equal(await repo.recordChecks('a.example', ALICE, checks, false), null)
  })
})
