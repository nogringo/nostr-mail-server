import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { migrate } from '../src/migrations.js'
import { generateKeyPair } from '../src/nostr.js'
import { PgDomainRepository } from '../src/repository.js'
import type { DomainChecks, NewDomain } from '../src/types.js'
import { newBridgeKey, outboundWrap, signer } from './helpers.js'

// Runs against a real Postgres when TEST_DATABASE_URL is set, inside a
// throwaway schema.
const databaseUrl = process.env.TEST_DATABASE_URL ?? ''

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

const checks: DomainChecks = {
  ownership: { status: 'ok', found: ['nostr-mail-verification=t'] },
  mx: { status: 'missing', found: [] },
  nip05: { status: 'missing', found: [] },
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
      '006_create_suspended_domains.sql',
      '007_create_abuse_reports.sql',
      '008_create_served_domains.sql',
      '009_create_server_key.sql',
      '010_add_bridge_bunker.sql',
      '011_create_allowed_keys.sql',
      '012_create_server_settings.sql',
      '013_add_service_settings.sql',
      '014_add_private_addresses.sql',
      '015_add_abuse_report_deletions.sql',
      '016_add_nip05_host.sql',
      '017_add_shared_domains.sql',
      '018_add_catch_all.sql',
      '019_add_address_enabled.sql',
      '020_add_quotas.sql',
      '021_add_address_keys.sql',
      '022_add_blobs.sql',
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
    const created = await repo.putAddress({
      domain: 'example.com',
      localPart: 'bob',
      pubkeys: [BOB],
      ownerPubkey: ALICE,
    })
    expect(created).toEqual({
      domain: 'example.com',
      localPart: 'bob',
      pubkeys: [BOB],
      ownerPubkey: ALICE,
      createdBy: ALICE,
      private: false,
      enabled: true,
      createdAt: expect.any(String),
    })

    const repointed = await repo.putAddress({ ...created, pubkeys: [CAROL], private: true, enabled: false })
    expect(repointed).toEqual({ ...created, pubkeys: [CAROL], private: true, enabled: false })
    expect(await repo.findAddress('example.com', 'bob')).toEqual(repointed)
    const several = await repo.putAddress({ ...repointed, pubkeys: [CAROL, BOB] })
    expect(await repo.findAddress('example.com', 'bob')).toEqual({ ...several, pubkeys: [CAROL, BOB] })

    await repo.putAddress({ domain: 'example.com', localPart: 'alice', pubkeys: [ALICE], ownerPubkey: ALICE })
    expect((await repo.listAddresses('example.com')).map((address) => address.localPart)).toEqual(['alice', 'bob'])

    expect(await repo.deleteAddress('example.com', 'alice')).toBe(true)
    expect(await repo.deleteAddress('example.com', 'alice')).toBe(false)
    expect(await repo.findAddress('example.com', 'alice')).toBeNull()
  })

  test('a deleted address waits until it is allowed, and the catch-all creates no deleted one', async () => {
    const owner = await repo.findVerifiedDomain('example.com')
    if (!owner) throw new Error('example.com is not verified')
    expect(await repo.listDeletedAddresses('example.com')).toEqual([
      { domain: 'example.com', localPart: 'alice', deletedAt: expect.any(String) },
    ])
    expect(await repo.isDeletedAddress('example.com', 'alice')).toBe(true)
    expect(await repo.createCatchAllAddress(owner, 'alice')).toBeNull()

    const caught = await repo.createCatchAllAddress(owner, 'alice+shop')
    expect(caught).toMatchObject({
      localPart: 'alice+shop',
      pubkeys: [ALICE],
      createdBy: ALICE,
      private: true,
      enabled: true,
    })
    expect(await repo.createCatchAllAddress(owner, 'bob')).toEqual(await repo.findAddress('example.com', 'bob'))

    expect(await repo.deleteAddress('example.com', 'alice+shop')).toBe(true)
    expect(await repo.allowDeletedAddresses('example.com', 'alice')).toBe(1)
    expect(await repo.allowDeletedAddresses('example.com', 'alice')).toBe(0)
    expect(await repo.allowDeletedAddresses('example.com')).toBe(1)
    expect(await repo.listDeletedAddresses('example.com')).toEqual([])
  })

  test('sets the catch-all of a claim', async () => {
    expect((await repo.setCatchAll('example.com', ALICE, true))?.catchAll).toBe(true)
    expect((await repo.findVerifiedDomain('example.com'))?.catchAll).toBe(true)
    expect(await repo.setCatchAll('example.com', CAROL, true)).toBeNull()
    expect((await repo.setCatchAll('example.com', ALICE, false))?.catchAll).toBe(false)
  })

  test('an address needs the claim of its owner, a valid local part and hex pubkeys', async () => {
    await expect(
      repo.putAddress({ domain: 'example.com', localPart: 'eve', pubkeys: [CAROL], ownerPubkey: CAROL }),
    ).rejects.toThrow(/foreign key/)
    await expect(
      repo.putAddress({ domain: 'example.com', localPart: 'Eve', pubkeys: [CAROL], ownerPubkey: ALICE }),
    ).rejects.toThrow(/addresses_local_part/)
    for (const pubkeys of [[], [CAROL, 'npub1carol']]) {
      await expect(
        repo.putAddress({ domain: 'example.com', localPart: 'eve', pubkeys, ownerPubkey: ALICE }),
      ).rejects.toThrow(/addresses_pubkeys_hex/)
    }
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
    await repo.putAddress({ domain: 'example.com', localPart: 'gone', pubkeys: [ALICE], ownerPubkey: ALICE })
    await repo.deleteAddress('example.com', 'gone')
    await repo.recordChecks('example.com', BOB, checks, true)

    expect(await repo.listAddresses('example.com')).toEqual([])
    expect(await repo.listDeletedAddresses('example.com')).toEqual([])
    expect((await repo.findVerifiedDomain('example.com'))?.pubkey).toBe(BOB)
  })

  test('finds the verified claims, also by their bridge key', async () => {
    const owner = await repo.findVerifiedDomain('example.com')
    const pending = await repo.createDomain(claim('pending.example', CAROL))

    expect((await repo.listVerifiedDomains()).map((domain) => domain.domain)).toEqual(['example.com'])
    expect(await repo.findVerifiedDomainByBridgePubkey(owner?.bridgePubkey ?? '')).toEqual(owner)
    expect(await repo.findVerifiedDomainByBridgePubkey(pending.bridgePubkey)).toBeNull()
  })

  test('a suspended domain is left out of the verified lookups until lifted', async () => {
    const owner = await repo.findVerifiedDomain('example.com')

    const suspension = await repo.suspendDomain('example.com')
    expect(await repo.suspendDomain('example.com')).toEqual(suspension)
    expect(suspension).toEqual({ domain: 'example.com', suspendedAt: expect.any(String) })
    expect(await repo.listSuspensions()).toEqual([suspension])
    expect(await repo.findVerifiedDomain('example.com')).toBeNull()
    expect(await repo.findVerifiedDomainByBridgePubkey(owner?.bridgePubkey ?? '')).toBeNull()
    expect(await repo.listVerifiedDomains()).toEqual([])
    expect(await repo.findDomain('example.com', BOB)).toEqual(owner)
    expect(await repo.findOwnedDomain('example.com')).toEqual(owner)

    expect(await repo.unsuspendDomain('example.com')).toBe(true)
    expect(await repo.unsuspendDomain('example.com')).toBe(false)
    expect(await repo.findSuspension('example.com')).toBeNull()
    expect(await repo.findVerifiedDomain('example.com')).toEqual(owner)
  })

  test('allows a key once and takes it back', async () => {
    const allowed = await repo.allowKey(CAROL)

    expect(await repo.allowKey(CAROL)).toEqual(allowed)
    expect(allowed).toEqual({ pubkey: CAROL, allowedAt: expect.any(String) })
    expect(await repo.isAllowedKey(CAROL)).toBe(true)
    expect(await repo.listAllowedKeys()).toEqual([allowed])

    expect(await repo.disallowKey(CAROL)).toBe(true)
    expect(await repo.disallowKey(CAROL)).toBe(false)
    expect(await repo.isAllowedKey(CAROL)).toBe(false)
    expect(await repo.listAllowedKeys()).toEqual([])
  })

  test('gives a key quotas of its own, replaces them and takes them back', async () => {
    const set = await repo.putKeyQuotas(CAROL, { addresses: 5, recipientsPerDay: null })
    expect(set).toEqual({
      pubkey: CAROL,
      quotas: { addresses: 5, recipientsPerDay: null },
      updatedAt: expect.any(String),
    })
    expect(await repo.findKeyQuotas(CAROL)).toEqual(set)

    const replaced = await repo.putKeyQuotas(CAROL, { pendingDomains: 2 })
    expect(replaced.quotas).toEqual({ pendingDomains: 2 })
    expect(await repo.listKeyQuotas()).toEqual([replaced])

    expect(await repo.deleteKeyQuotas(CAROL)).toBe(true)
    expect(await repo.deleteKeyQuotas(CAROL)).toBe(false)
    expect(await repo.findKeyQuotas(CAROL)).toBeNull()
  })

  test('counts the addresses a key created, on any domain', async () => {
    await repo.putAddress({ domain: 'example.com', localPart: 'counted', pubkeys: [CAROL], ownerPubkey: BOB })

    expect(await repo.countCreatedAddresses(BOB)).toBe(1)
    expect(await repo.countCreatedAddresses(CAROL)).toBe(0)
    await repo.deleteAddress('example.com', 'counted')
    expect(await repo.countCreatedAddresses(BOB)).toBe(0)
  })

  test('sums the usage of a quota since a date, and prunes the old one', async () => {
    const hourAgo = new Date(Date.now() - 3600_000)
    await repo.addQuotaUsage('recipientsPerDay', 'example.com', 3)
    await repo.addQuotaUsage('recipientsPerDay', 'example.com', 4)
    await repo.addQuotaUsage('recipientsPerDay', 'other.example', 50)
    await repo.addQuotaUsage('addressesPerHour', 'example.com', 1)

    expect(await repo.countQuotaUsage('recipientsPerDay', 'example.com', hourAgo)).toBe(7)
    expect(await repo.countQuotaUsage('addressesPerHour', ALICE, hourAgo)).toBe(0)
    expect(await repo.countQuotaUsage('recipientsPerDay', 'example.com', new Date(Date.now() + 60_000))).toBe(0)

    expect(await repo.pruneQuotaUsage(hourAgo)).toBe(0)
    expect(await repo.pruneQuotaUsage(new Date(Date.now() + 60_000))).toBe(4)
    expect(await repo.countQuotaUsage('recipientsPerDay', 'example.com', hourAgo)).toBe(0)
  })

  test('starts with the defaults the environment variables had, then stores what an admin sets', async () => {
    const defaults = await repo.findSettings()
    expect(defaults).toEqual({
      openRegistration: false,
      maxMessageBytes: 25 * 1024 * 1024,
      maxBlobStorageBytes: 1024 * 1024 * 1024,
      blossomServers: ['https://blossom.nmail.li', 'https://blossom.yakihonne.com', 'https://blossom.ditto.pub'],
      domainRelays: ['wss://relay.nmail.li/', 'wss://relay.ditto.pub/', 'wss://nos.lol/', 'wss://relay.primal.net/'],
      domainBlossomServer: null,
      indexerRelays: ['wss://purplepag.es/', 'wss://user.kindpag.es/', 'wss://indexer.coracle.social/'],
      quotas: {
        addresses: null,
        addressesPerHour: null,
        pendingDomains: null,
        recipientsPerDay: null,
        keysPerAddress: null,
      },
      retiredDomainRelays: {},
    })

    const changed = {
      openRegistration: true,
      maxMessageBytes: 1024 * 1024,
      maxBlobStorageBytes: 5 * 1024 * 1024 * 1024,
      blossomServers: ['https://cdn.example.com/blossom'],
      domainRelays: ['wss://relay.example.com/'],
      domainBlossomServer: 'https://mx.example.com',
      indexerRelays: ['wss://indexer.example.com/'],
      quotas: { addresses: 10, addressesPerHour: 5, pendingDomains: 0, recipientsPerDay: null, keysPerAddress: 3 },
      retiredDomainRelays: { 'wss://relay.nmail.li/': '2026-10-28T12:00:00.000Z' },
    }
    await repo.updateSettings(changed)
    expect(await repo.findSettings()).toEqual(changed)
    await repo.updateSettings(defaults)
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

  test('keeps a blob while an email in it waits, then drops it once sent, or unclaimed after a while', async () => {
    const bridgePubkey = (await repo.findVerifiedDomain('example.com'))?.bridgePubkey ?? ''
    const sent = 'd'.repeat(64)
    const unclaimed = 'e'.repeat(64)
    await repo.addBlob(sent, Buffer.from('mail'), ALICE)
    await repo.addBlob(sent, Buffer.from('again'), BOB)
    await repo.addBlob(unclaimed, Buffer.from('nothing'), ALICE)
    const wrap = outboundWrap(signer(), bridgePubkey)
    const recipients = ['a@remote.example']
    await repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey, wrap, recipients, blobSha256: sent })
    const later = { status: 'pending' as const, response: 'No blob', nextAttemptAt: new Date(Date.now() + 60_000) }
    await repo.recordOutcomes(wrap.id, new Map([['a@remote.example', later]]))

    expect(await repo.findBlob(sent)).toEqual({
      sha256: sent,
      data: Buffer.from('mail'),
      uploadedAt: expect.any(String),
    })
    expect(await repo.countBlobBytes()).toBe(11)
    expect(await repo.wakeBlobRecipients(sent)).toBe(1)
    expect((await repo.listDueOutboundMessages(10)).map((message) => message.wrapId)).toContain(wrap.id)
    expect(await repo.pruneBlobs(new Date(Date.now() + 60_000))).toBe(1)
    expect(await repo.findBlob(unclaimed)).toBeNull()

    await repo.recordOutcomes(wrap.id, new Map([['a@remote.example', { status: 'delivered', response: '250 OK' }]]))
    expect(await repo.pruneBlobs(new Date(Date.now() - 60_000))).toBe(1)
    expect(await repo.findBlob(sent)).toBeNull()
  })

  test('the outbound mail of a claim goes away with it', async () => {
    await repo.deleteDomain('example.com', BOB)

    const remaining = await admin.query(`select count(*)::int as count from ${schema}.outbound_messages`)
    expect(remaining.rows).toEqual([{ count: 0 }])
  })

  test('replacing the bridge key drops the outbound mail wrapped to the old one', async () => {
    const created = await repo.createDomain(claim('rekeyed.example', CAROL))
    const other = await repo.createDomain(claim('other.example', CAROL))
    const wrap = outboundWrap(signer(), created.bridgePubkey)
    const recipients = ['a@remote.example']
    await repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey: created.bridgePubkey, wrap, recipients })
    const replacement = newBridgeKey()

    const replaced = await repo.replaceBridgeKey('rekeyed.example', CAROL, replacement)

    expect(replaced).toEqual({ ...created, ...replacement })
    expect(await repo.findDomain('rekeyed.example', CAROL)).toEqual(replaced)
    expect(await repo.hasOutboundMessage(wrap.id)).toBe(false)
    expect(await repo.hasBridgeKey(replacement.bridgePubkey)).toBe(true)
    expect(await repo.hasBridgeKey(created.bridgePubkey)).toBe(false)
    expect(await repo.replaceBridgeKey('rekeyed.example', ALICE, newBridgeKey())).toBeNull()
    await expect(repo.replaceBridgeKey('other.example', CAROL, replacement)).rejects.toThrow(
      /domains_bridge_pubkey_unique/,
    )
    expect(await repo.findDomain('other.example', CAROL)).toEqual(other)

    await repo.deleteDomain('rekeyed.example', CAROL)
    await repo.deleteDomain('other.example', CAROL)
  })

  test('a domain key moves into a bunker and back with its outbound mail', async () => {
    const created = await repo.createDomain(claim('bunker.example', CAROL))
    const wrap = outboundWrap(signer(), created.bridgePubkey)
    const recipients = ['a@remote.example']
    await repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey: created.bridgePubkey, wrap, recipients })
    const bridgeBunker = { signerPubkey: BOB, relays: ['wss://bunker.example.org/'], clientKey: ALICE }
    const inBunker = { bridgePubkey: created.bridgePubkey, bridgePrivateKey: null, bridgeBunker }

    const moved = await repo.replaceBridgeKey('bunker.example', CAROL, inBunker)

    expect(moved).toEqual({ ...created, ...inBunker })
    expect(await repo.findDomain('bunker.example', CAROL)).toEqual(moved)
    expect(await repo.hasOutboundMessage(wrap.id)).toBe(true)
    await expect(
      repo.replaceBridgeKey('bunker.example', CAROL, { ...inBunker, bridgePrivateKey: created.bridgePrivateKey }),
    ).rejects.toThrow(/domains_bridge_key_held/)
    expect(await repo.replaceBridgeKey('bunker.example', CAROL, { ...created, bridgeBunker: null })).toEqual(created)

    await repo.deleteDomain('bunker.example', CAROL)
  })

  test('keeps an abuse report once per domain and message, and lists the newest first', async () => {
    const message = Buffer.from('Subject: Spam\r\n\r\n\xff raw byte\r\n', 'latin1')
    const report = { mailFrom: 'spam@sender.example', from: 'Spam <spam@sender.example>', subject: 'Spam', message }
    await repo.addAbuseReport({ ...report, domain: 'example.com', emailId: 'one' })
    await repo.addAbuseReport({ ...report, domain: 'example.com', emailId: 'one' })
    await repo.addAbuseReport({ ...report, domain: 'other.example', emailId: 'one' })

    const listed = await repo.listAbuseReports('admin')
    expect(listed.map((kept) => kept.domain)).toEqual(['other.example', 'example.com'])
    expect(listed[1]).toEqual({
      id: expect.any(Number),
      domain: 'example.com',
      mailFrom: 'spam@sender.example',
      from: 'Spam <spam@sender.example>',
      subject: 'Spam',
      size: message.length,
      receivedAt: expect.any(String),
    })
    const owner = { domain: 'example.com', since: listed[1].receivedAt }
    expect(await repo.listAbuseReports(owner)).toEqual([listed[1]])
    expect(
      await repo.listAbuseReports({ domain: 'example.com', since: new Date(Date.now() + 60_000).toISOString() }),
    ).toEqual([])
    expect(await repo.findAbuseMessage(listed[1].id, 'admin')).toEqual(message)
    expect(await repo.findAbuseMessage(listed[1].id, owner)).toEqual(message)
    expect(await repo.findAbuseMessage(listed[0].id, owner)).toBeNull()
    expect(await repo.findAbuseMessage(0, 'admin')).toBeNull()
  })

  test('deletes an abuse report for one reader, and for good once nobody reads it', async () => {
    const message = Buffer.from('Subject: Spam\r\n\r\nHello\r\n')
    const receive = (emailId: string) =>
      repo.addAbuseReport({ domain: 'reported.example', emailId, mailFrom: '', from: '', subject: emailId, message })
    const subjects = (reports: { domain: string; subject: string }[]) =>
      reports.filter((report) => report.domain === 'reported.example').map((report) => report.subject)
    const idOf = async (subject: string) =>
      (await repo.listAbuseReports('admin')).find((report) => report.subject === subject)?.id ?? 0
    const stored = async () =>
      subjects((await admin.query(`select domain, subject from ${schema}.abuse_reports order by id desc`)).rows)

    await repo.createDomain(claim('reported.example', CAROL))
    const carol = await repo.recordChecks('reported.example', CAROL, checks, true)
    const owner = { domain: 'reported.example', since: carol?.verifiedAt ?? '' }
    for (const emailId of ['one', 'two', 'three']) await receive(emailId)
    const [three, two, one] = await repo.listAbuseReports(owner)

    expect(await repo.deleteAbuseReport(one.id, 'admin')).toBe(true)
    expect(await repo.deleteAbuseReport(one.id, 'admin')).toBe(false)
    expect(await repo.deleteAbuseReport(two.id, owner)).toBe(true)
    expect(subjects(await repo.listAbuseReports('admin'))).toEqual(['three', 'two'])
    expect(subjects(await repo.listAbuseReports(owner))).toEqual(['three', 'one'])
    expect(await repo.findAbuseMessage(one.id, 'admin')).toBeNull()
    expect(await repo.findAbuseMessage(one.id, owner)).toEqual(message)

    await repo.deleteAbuseReport(one.id, owner)
    await repo.deleteAbuseReport(two.id, 'admin')
    await repo.deleteAbuseReport(three.id, 'admin')
    expect(await stored()).toEqual(['three'])

    await repo.createDomain(claim('reported.example', BOB))
    await repo.recordChecks('reported.example', BOB, checks, true)
    expect(await stored()).toEqual([])

    await receive('four')
    await repo.deleteAbuseReport(await idOf('four'), 'admin')
    expect(await stored()).toEqual(['four'])
    await repo.deleteDomain('reported.example', BOB)
    expect(await stored()).toEqual([])

    await receive('five')
    await repo.deleteAbuseReport(await idOf('five'), 'admin')
    expect(await stored()).toEqual([])
  })

  test('remembers a domain once a claim on it is verified, also after it is released', async () => {
    await repo.createDomain(claim('served.example', CAROL))
    await repo.recordChecks('served.example', CAROL, checks, false)
    expect(await repo.hasServedDomain('served.example')).toBe(false)

    await repo.recordChecks('served.example', CAROL, checks, true)
    await repo.recordChecks('served.example', CAROL, checks, true)
    await repo.deleteDomain('served.example', CAROL)

    expect(await repo.hasServedDomain('served.example')).toBe(true)
    expect(await repo.findOwnedDomain('served.example')).toBeNull()
  })

  test('a shared domain in service lists the addresses other keys create there', async () => {
    await repo.createDomain(claim('shared.example', CAROL))
    await repo.recordChecks('shared.example', CAROL, checks, true)
    expect((await repo.setShared('shared.example', CAROL, true))?.shared).toBe(true)
    expect(await repo.listSharedDomains()).toEqual(['shared.example'])

    const member = { domain: 'shared.example', pubkeys: [ALICE], ownerPubkey: CAROL, createdBy: ALICE }
    const zoe = await repo.putCreatedAddress({ ...member, localPart: 'zoe' })
    expect(zoe).toMatchObject({ ...member, localPart: 'zoe', private: false, enabled: true })
    await repo.putCreatedAddress({ ...member, localPart: 'alice' })
    await repo.putAddress({ domain: 'shared.example', localPart: 'carol', pubkeys: [CAROL], ownerPubkey: CAROL })
    expect((await repo.listCreatedAddresses(ALICE)).map((address) => address.localPart)).toEqual(['alice', 'zoe'])
    expect(await repo.listCreatedAddresses(CAROL)).toEqual([])

    expect(await repo.putCreatedAddress({ ...member, localPart: 'zoe', private: true, enabled: false })).toEqual({
      ...zoe,
      private: true,
      enabled: false,
    })
    expect(await repo.putCreatedAddress({ ...member, localPart: 'carol' })).toBeNull()
    expect(await repo.putCreatedAddress({ ...member, pubkeys: [BOB], createdBy: BOB, localPart: 'zoe' })).toBeNull()

    await repo.putAddress({ ...member, localPart: 'zoe', createdBy: CAROL, private: false })
    expect((await repo.findAddress('shared.example', 'zoe'))?.createdBy).toBe(ALICE)
    await repo.putAddress({ ...member, localPart: 'zoe', pubkeys: [CAROL], createdBy: CAROL })
    expect((await repo.findAddress('shared.example', 'zoe'))?.createdBy).toBe(CAROL)

    expect(await repo.deleteAddress('shared.example', 'carol', ALICE)).toBe(false)
    expect(await repo.deleteAddress('shared.example', 'alice', ALICE)).toBe(true)

    await repo.suspendDomain('shared.example')
    expect(await repo.listSharedDomains()).toEqual([])
    await repo.unsuspendDomain('shared.example')
    await repo.deleteDomain('shared.example', CAROL)
    expect(await repo.listAddresses('shared.example')).toEqual([])
  })

  test('creates the server key once and keeps it', async () => {
    const first = generateKeyPair()

    expect(await repo.findOrCreateServerKey(first)).toEqual(first)
    expect(await repo.findOrCreateServerKey(generateKeyPair())).toEqual(first)
  })
})
