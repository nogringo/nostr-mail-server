import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrate } from '../src/migrations.js'
import { PgDomainRepository } from '../src/repository.js'
import type { DomainChecks, NewDomain } from '../src/types.js'

// Runs against a real Postgres when TEST_DATABASE_URL is set, inside a
// throwaway schema.
const databaseUrl = process.env.TEST_DATABASE_URL ?? ''

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

describe.skipIf(!databaseUrl)('PgDomainRepository', () => {
  const schema = `test_${randomBytes(6).toString('hex')}`
  let admin: pg.Client
  let url: string
  let applied: string[]
  let repo: PgDomainRepository

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`create schema ${schema}`)

    const schemaUrl = new URL(databaseUrl)
    schemaUrl.searchParams.set('options', `-c search_path=${schema}`)
    url = schemaUrl.toString()
    applied = await migrate(url)
    repo = new PgDomainRepository(url)
  })

  afterAll(async () => {
    await repo?.close()
    await admin?.query(`drop schema ${schema} cascade`)
    await admin?.end()
  })

  test('applies the pending migrations once', async () => {
    expect(applied).toEqual(['001_create_domains.sql'])
    expect(await migrate(url)).toEqual([])
  })

  test('creates a claim once per key', async () => {
    const created = await repo.createDomain(claim('example.com', ALICE))
    const again = await repo.createDomain(claim('example.com', ALICE))

    expect(again.verificationToken).toBe(created.verificationToken)
    expect(created.verifiedAt).toBeNull()
    expect(await repo.findDomain('example.com', ALICE)).toEqual(created)
  })

  test('lists the claims of a key', async () => {
    await repo.createDomain(claim('a.example', ALICE))
    await repo.createDomain(claim('example.com', BOB))

    expect((await repo.listDomains(ALICE)).map((domain) => domain.domain)).toEqual(['a.example', 'example.com'])
  })

  test('records checks without verifying', async () => {
    const updated = await repo.recordChecks(
      'example.com',
      BOB,
      { ...checks, ownership: { status: 'missing', found: [] } },
      false,
    )

    expect(updated?.verifiedAt).toBeNull()
    expect(updated?.checkedAt).toBeTypeOf('string')
    expect(updated?.checks?.ownership.status).toBe('missing')
    expect(await repo.findDomain('example.com', ALICE)).not.toBeNull()
  })

  test('verifying drops the other claims and keeps the first verification time', async () => {
    const verified = await repo.recordChecks('example.com', ALICE, checks, true)
    expect(verified?.verifiedAt).toBeTypeOf('string')
    expect(verified?.checks).toEqual(checks)
    expect(await repo.findDomain('example.com', BOB)).toBeNull()

    const rechecked = await repo.recordChecks('example.com', ALICE, checks, true)
    expect(rechecked?.verifiedAt).toBe(verified?.verifiedAt)
  })

  test('a domain has at most one verified owner', async () => {
    await repo.createDomain(claim('example.com', BOB))
    await expect(
      admin.query(`update ${schema}.domains set verified_at = now() where domain = 'example.com' and pubkey = $1`, [
        BOB,
      ]),
    ).rejects.toThrow(/domains_one_verified_owner/)
  })

  test('deletes a claim', async () => {
    expect(await repo.deleteDomain('a.example', ALICE)).toBe(true)
    expect(await repo.deleteDomain('a.example', ALICE)).toBe(false)
    expect(await repo.recordChecks('a.example', ALICE, checks, false)).toBeNull()
  })
})
