import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrate } from '../src/migrations.js'
import { generateKeyPair } from '../src/nostr.js'
import { PgDomainRepository } from '../src/repository.js'
import type { DomainChecks, NewDomain } from '../src/types.js'
import { outboundWrap, signer } from './helpers.js'

// Runs against a real Postgres when TEST_DATABASE_URL is set, inside a
// throwaway schema.
const databaseUrl = process.env.TEST_DATABASE_URL ?? ''

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

const checks: DomainChecks = {
  ownership: { status: 'ok', found: ['nostr-mail-verification=t'] },
  mx: { status: 'missing', found: [] },
  https: { status: 'missing', found: [] },
  spf: { status: 'missing', found: [] },
  dkim: { status: 'missing', found: [] },
  dmarc: { status: 'missing', found: [] },
}

function claim(domain: string, pubkey: string): NewDomain {
  const bridge = generateKeyPair()
  return {
    domain,
    pubkey,
    verificationToken: randomBytes(4).toString('hex'),
    dkimSelector: 'nostrmail',
    dkimPublicKey: 'public',
    dkimPrivateKey: 'private',
    bridgePubkey: bridge.pubkey,
    bridgePrivateKey: bridge.privateKey,
    blossomServers: ['https://blossom.example.org', 'https://cdn.example.com/blossom'],
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
    expect(applied).toEqual([
      '001_create_domains.sql',
      '002_create_addresses.sql',
      '003_add_bridge_keys.sql',
      '004_add_blossom_servers.sql',
      '005_create_outbound.sql',
    ])
    expect(await migrate(url)).toEqual([])
  })

  test('creates a claim once per key', async () => {
    const created = await repo.createDomain(claim('example.com', ALICE))
    const again = await repo.createDomain(claim('example.com', ALICE))

    expect(again.verificationToken).toBe(created.verificationToken)
    expect(created.blossomServers).toEqual(['https://blossom.example.org', 'https://cdn.example.com/blossom'])
    expect(created.verifiedAt).toBeNull()
    expect(await repo.findDomain('example.com', ALICE)).toEqual(created)
  })

  test('two claims never share a bridge key', async () => {
    const taken = await repo.createDomain(claim('shared.example', ALICE))

    await expect(
      repo.createDomain({ ...claim('shared.example', BOB), bridgePubkey: taken.bridgePubkey }),
    ).rejects.toThrow(/domains_bridge_pubkey_unique/)
    expect(await repo.deleteDomain('shared.example', ALICE)).toBe(true)
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

  test('finds the verified claim of a domain', async () => {
    expect((await repo.findVerifiedDomain('example.com'))?.pubkey).toBe(ALICE)
    expect(await repo.findVerifiedDomain('unknown.example')).toBeNull()
  })

  test('creates, repoints, lists and deletes addresses', async () => {
    const created = await repo.putAddress({ domain: 'example.com', localPart: 'bob', pubkey: BOB, ownerPubkey: ALICE })
    expect(created).toEqual({
      domain: 'example.com',
      localPart: 'bob',
      pubkey: BOB,
      ownerPubkey: ALICE,
      createdAt: expect.any(String),
    })

    const repointed = await repo.putAddress({ ...created, pubkey: CAROL })
    expect(repointed).toEqual({ ...created, pubkey: CAROL })
    expect(await repo.findAddress('example.com', 'bob')).toEqual(repointed)

    await repo.putAddress({ domain: 'example.com', localPart: 'alice', pubkey: ALICE, ownerPubkey: ALICE })
    expect((await repo.listAddresses('example.com')).map((address) => address.localPart)).toEqual(['alice', 'bob'])

    expect(await repo.deleteAddress('example.com', 'alice')).toBe(true)
    expect(await repo.deleteAddress('example.com', 'alice')).toBe(false)
    expect(await repo.findAddress('example.com', 'alice')).toBeNull()
  })

  test('an address needs the claim of its owner and a valid local part', async () => {
    await expect(
      repo.putAddress({ domain: 'example.com', localPart: 'eve', pubkey: CAROL, ownerPubkey: CAROL }),
    ).rejects.toThrow(/foreign key/)
    await expect(
      repo.putAddress({ domain: 'example.com', localPart: 'Eve', pubkey: CAROL, ownerPubkey: ALICE }),
    ).rejects.toThrow(/addresses_local_part/)
  })

  test('lists every claim with the addresses it declared', async () => {
    const summaries = await repo.listAllDomains()

    expect(summaries.map(({ domain, pubkey, addressCount }) => ({ domain, pubkey, addressCount }))).toEqual([
      { domain: 'example.com', pubkey: ALICE, addressCount: 1 },
      { domain: 'example.com', pubkey: BOB, addressCount: 0 },
    ])
    expect(summaries[0].verifiedAt).toBeTypeOf('string')
  })

  test('the addresses go away when another key takes the domain over', async () => {
    await repo.recordChecks('example.com', BOB, checks, true)

    expect(await repo.listAddresses('example.com')).toEqual([])
    expect((await repo.findVerifiedDomain('example.com'))?.pubkey).toBe(BOB)
  })

  test('finds the verified claims, also by their bridge key', async () => {
    const owner = await repo.findVerifiedDomain('example.com')
    const pending = await repo.createDomain(claim('pending.example', CAROL))

    expect((await repo.listVerifiedDomains()).map((domain) => domain.domain)).toEqual(['example.com'])
    expect(await repo.findVerifiedDomainByBridgePubkey(owner?.bridgePubkey ?? '')).toEqual(owner)
    expect(await repo.findVerifiedDomainByBridgePubkey(pending.bridgePubkey)).toBeNull()
  })

  test('queues a wrap once and lists its recipients while they are due', async () => {
    const bridgePubkey = (await repo.findVerifiedDomain('example.com'))?.bridgePubkey ?? ''
    const wrap = outboundWrap(signer(), bridgePubkey)
    const recipients = ['b@remote.example', 'a@remote.example']

    await repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey, wrap, recipients })
    await repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey, refusal: 'Seen again' })

    expect(await repo.hasOutboundMessage(wrap.id)).toBe(true)
    expect(await repo.listDueOutboundMessages(10)).toEqual([
      {
        wrapId: wrap.id,
        bridgePubkey,
        wrap: JSON.parse(JSON.stringify(wrap)),
        receivedAt: expect.any(String),
        recipients: [
          { address: 'a@remote.example', attempts: 0 },
          { address: 'b@remote.example', attempts: 0 },
        ],
      },
    ])

    await repo.recordOutcomes(
      wrap.id,
      new Map([
        ['a@remote.example', { status: 'delivered', response: '250 OK' }],
        [
          'b@remote.example',
          { status: 'pending', response: '451 Later', nextAttemptAt: new Date(Date.now() + 60_000) },
        ],
      ]),
    )
    expect(await repo.listDueOutboundMessages(10)).toEqual([])

    await admin.query(`update ${schema}.outbound_recipients set next_attempt_at = now()`)
    expect((await repo.listDueOutboundMessages(10)).map((message) => message.recipients)).toEqual([
      [{ address: 'b@remote.example', attempts: 1 }],
    ])

    await repo.recordOutcomes(wrap.id, new Map([['b@remote.example', { status: 'failed', response: '550 No' }]]))
    const stored = await admin.query(`select wrap from ${schema}.outbound_messages where wrap_id = $1`, [wrap.id])
    expect(stored.rows).toEqual([{ wrap: null }])
  })

  test('prunes the old messages that wait for nothing', async () => {
    const bridgePubkey = (await repo.findVerifiedDomain('example.com'))?.bridgePubkey ?? ''
    const waiting = outboundWrap(signer(), bridgePubkey)
    await repo.addOutboundMessage({ wrapId: 'refused', bridgePubkey, refusal: 'Not an address of the sender' })
    await repo.addOutboundMessage({ wrapId: waiting.id, bridgePubkey, wrap: waiting, recipients: ['a@remote.example'] })

    expect(await repo.pruneOutboundMessages(new Date(Date.now() - 60_000))).toBe(0)
    expect(await repo.pruneOutboundMessages(new Date(Date.now() + 60_000))).toBe(2)
    expect(await repo.hasOutboundMessage(waiting.id)).toBe(true)
  })

  test('the outbound mail of a claim goes away with it', async () => {
    await repo.deleteDomain('example.com', BOB)

    const remaining = await admin.query(`select count(*)::int as count from ${schema}.outbound_messages`)
    expect(remaining.rows).toEqual([{ count: 0 }])
  })
})
