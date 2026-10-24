import { createDecipheriv } from 'node:crypto'
import { type AddressInfo, connect } from 'node:net'
import { dkimSign } from 'mailauth'
import nodemailer from 'nodemailer'
import { npubEncode } from 'nostr-tools/nip19'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, expect, test } from 'vitest'
import { DomainSigners } from '../src/bunker.js'
import { generateDkimKeyPair } from '../src/dkim.js'
import { MAX_BUNKER_INLINE_MIME_BYTES, MAX_INLINE_MIME_BYTES } from '../src/inbound.js'
import { generateKeyPair } from '../src/nostr.js'
import { createSmtpServer } from '../src/smtp.js'
import type { TlsCredentials } from '../src/tls.js'
import {
  claim,
  FakeAuthDns,
  FakeBlobStore,
  FakeBunker,
  FakeRelayNetwork,
  MemoryDomainRepository,
  openWrap,
  readFixtureTls,
  replyReader,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

const MAX_MESSAGE_BYTES = 256 * 1024
const DOMAIN_SERVER = 'https://blossom.example.org'
const SERVER_BLOSSOM = 'https://blossom.server.example'

const MESSAGE = [
  'From: Alice <alice@sender.example>',
  'To: bob@example.com',
  'Subject: Hello',
  'Message-ID: <1@sender.example>',
  '',
  'Hi Bob',
  '',
].join('\r\n')

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup({
  tls,
  adminPubkeys = [],
  bunker = new FakeBunker(),
}: {
  tls?: TlsCredentials
  adminPubkeys?: string[]
  bunker?: FakeBunker
} = {}) {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const blobs = new FakeBlobStore()
  const authDns = new FakeAuthDns()
  const serverKey = generateKeyPair()
  const settings = settingsStore(repo, { maxMessageBytes: MAX_MESSAGE_BYTES, blossomServers: [SERVER_BLOSSOM] })
  const server = createSmtpServer(
    repo,
    network,
    blobs,
    authDns.resolve,
    settings,
    { mxHost: 'mx.example.org', adminPubkeys, serverPrivateKey: serverKey.privateKey },
    { tls, signers: new DomainSigners({ open: bunker.open, timeoutMs: 50 }) },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as AddressInfo).port
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true })
  cleanups.push(async () => {
    transport.close()
    await new Promise<void>((resolve) => server.close(resolve))
  })

  const owner = signer()
  const domain = await verifyDomain(repo, 'example.com', owner.pubkey)
  const bob = signer()
  await repo.putAddress({ domain: 'example.com', localPart: 'bob', pubkeys: [bob.pubkey], ownerPubkey: owner.pubkey })
  network.inboxRelays.set(bob.pubkey, ['wss://inbox.bob.example/'])

  const send = (to: string[], raw = MESSAGE) =>
    transport.sendMail({ envelope: { from: 'alice@sender.example', to }, raw })

  return { repo, network, blobs, authDns, port, serverKey, owner, domain, bob, send, settings }
}

test('a message to a declared address is gift wrapped to its pubkey and published', async () => {
  const { network, domain, bob, send } = await setup()

  const info = await send(['Bob@Example.com'])

  expect(info.rejected).toEqual([])
  expect(network.published).toHaveLength(1)
  const [{ relays, event, auth }] = network.published
  expect(relays).toEqual(['wss://inbox.bob.example/'])
  expect(event.kind).toBe(1059)
  expect(event.tags).toEqual([['p', bob.pubkey]])
  expect(auth.pubkey).toBe(domain.bridgePubkey)

  const { seal, rumor } = openWrap(event, bob.sk)
  expect(seal.pubkey).toBe(domain.bridgePubkey)
  expect(rumor.pubkey).toBe(domain.bridgePubkey)
  expect(rumor.kind).toBe(1301)
  expect(rumor.tags).toEqual([
    ['email-id', expect.stringMatching(/^[0-9a-f]{64}$/)],
    ['mail-from', 'alice@sender.example'],
  ])
  expect(rumor.content).toMatch(
    /^Return-Path: <alice@sender\.example>\r\nReceived-SPF: [\s\S]+?\r\nAuthentication-Results: mx\.example\.org;[\s\S]+?\r\nReceived: from .+\r\n\tby mx\.example\.org with ESMTP id \w+;\r\n\t.+ \+0000\r\n/,
  )
  expect(rumor.content.endsWith(MESSAGE)).toBe(true)
})

test('a private address is delivered like a public one', async () => {
  const { repo, network, owner, bob, send } = await setup()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'shop',
    pubkeys: [bob.pubkey],
    ownerPubkey: owner.pubkey,
    private: true,
  })

  const info = await send(['shop@example.com'])

  expect(info.rejected).toEqual([])
  expect(openWrap(network.published[0].event, bob.sk).rumor.kind).toBe(1301)
})

test('a disabled address takes the mail and drops it, answered like a delivery', async () => {
  const { repo, network, owner, bob, send } = await setup()
  // No inbox relays: a disabled address does not need any.
  const carol = signer()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'shop',
    pubkeys: [carol.pubkey],
    ownerPubkey: owner.pubkey,
    enabled: false,
  })

  const dropped = await send(['shop@example.com'])
  const mixed = await send(['shop@example.com', 'bob@example.com'])

  expect(dropped.rejected).toEqual([])
  expect(dropped.response).toMatch(/Delivered over Nostr/)
  expect(mixed.response).toMatch(/Delivered over Nostr/)
  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([bob.pubkey])
})

test('an npub address is delivered without being declared', async () => {
  const { network, send } = await setup()
  const carol = signer()
  network.inboxRelays.set(carol.pubkey, ['wss://inbox.carol.example/'])

  await send([`${npubEncode(carol.pubkey)}@example.com`])

  expect(openWrap(network.published[0].event, carol.sk).rumor.kind).toBe(1301)
})

test('a catch-all domain creates the address it does not know for its owner, private', async () => {
  const { repo, network, owner, send } = await setup()
  await repo.setCatchAll('example.com', owner.pubkey, true)
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])

  const info = await send(['Bob+News@example.com', 'shop@example.com'])

  expect(info.rejected).toEqual([])
  expect(await repo.findAddress('example.com', 'bob+news')).toMatchObject({
    pubkeys: [owner.pubkey],
    createdBy: owner.pubkey,
    private: true,
  })
  expect((await repo.findAddress('example.com', 'shop'))?.pubkeys).toEqual([owner.pubkey])
  expect(network.published).toHaveLength(1)
  expect(openWrap(network.published[0].event, owner.sk).rumor.kind).toBe(1301)
})

test('a catch-all creates no address past the quotas of its owner', async () => {
  const { repo, network, owner, send, settings } = await setup()
  await repo.setCatchAll('example.com', owner.pubkey, true)
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  await settings.update({ quotas: { addresses: 2 } })

  await send(['shop@example.com'])
  await expect(send(['news@example.com'])).rejects.toMatchObject({ responseCode: 550 })

  expect(await repo.findAddress('example.com', 'news')).toBeNull()
  expect(repo.quotaUsage.map(({ quota, subject }) => [quota, subject])).toEqual([['addressesPerHour', owner.pubkey]])
})

test('a catch-all does not take a disabled address back', async () => {
  const { repo, network, owner, send } = await setup()
  await repo.setCatchAll('example.com', owner.pubkey, true)
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'shop',
    pubkeys: [owner.pubkey],
    ownerPubkey: owner.pubkey,
    enabled: false,
  })

  await send(['shop@example.com'])

  expect(network.published).toEqual([])
  expect((await repo.findAddress('example.com', 'shop'))?.enabled).toBe(false)
})

test('a catch-all creates no deleted, reserved or shared address', async () => {
  const { repo, owner, bob, send } = await setup()
  await repo.setCatchAll('example.com', owner.pubkey, true)
  await repo.putAddress({ domain: 'example.com', localPart: 'shop', pubkeys: [bob.pubkey], ownerPubkey: owner.pubkey })
  await repo.deleteAddress('example.com', 'shop')

  for (const address of ['shop@example.com', '_smtp@example.com', 'npub1typo@example.com']) {
    await expect(send([address]), address).rejects.toMatchObject({ responseCode: 550 })
  }
  await repo.setShared('example.com', owner.pubkey, true)
  await expect(send(['zoe@example.com'])).rejects.toMatchObject({ responseCode: 550 })
  expect((await repo.listAddresses('example.com')).map((address) => address.localPart)).toEqual(['bob'])
})

test.each([
  'nobody@example.com',
  'bob+news@example.com',
  '_smtp@example.com',
  'bob@unknown.example',
  'bob@pending.example',
  'abuse@unknown.example',
  'abuse@pending.example',
])('%s is refused with 550', async (address) => {
  const { repo, send } = await setup()
  await repo.createDomain(claim('pending.example', signer().pubkey))

  await expect(send([address])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 })
})

test('the known recipients still get the message when others are refused', async () => {
  const { network, send } = await setup()

  const info = await send(['bob@example.com', 'nobody@example.com'])

  expect(info.accepted).toEqual(['bob@example.com'])
  expect(info.rejected).toEqual(['nobody@example.com'])
  expect(network.published).toHaveLength(1)
})

test('a suspended domain refuses its recipients with 550', async () => {
  const { repo, network, send } = await setup()
  await repo.suspendDomain('example.com')

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 })
  expect(network.published).toEqual([])
})

test('abuse@ of a suspended domain still reaches its owner and the admins, and is kept', async () => {
  const admin = signer()
  const { repo, network, owner, domain, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  network.inboxRelays.set(admin.pubkey, ['wss://inbox.admin.example/'])
  await repo.suspendDomain('example.com')

  await send(['abuse@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([owner.pubkey, admin.pubkey])
  expect(openWrap(network.published[0].event, owner.sk).seal.pubkey).toBe(domain.bridgePubkey)
  expect(repo.abuseReports.map(({ report }) => report.domain)).toEqual(['example.com'])
})

test('abuse@ of a suspended domain nobody owns reaches the admins under the server key', async () => {
  const admin = signer()
  const { repo, network, blobs, serverKey, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(admin.pubkey, ['wss://inbox.admin.example/'])
  await repo.suspendDomain('spam.example')

  await send(['abuse@spam.example'], largeMessage(MAX_INLINE_MIME_BYTES))

  expect(network.published).toHaveLength(1)
  expect(openWrap(network.published[0].event, admin.sk).seal.pubkey).toBe(serverKey.pubkey)
  expect(network.published[0].auth.pubkey).toBe(serverKey.pubkey)
  expect(blobs.uploads[0].servers).toContain(SERVER_BLOSSOM)
  expect(blobs.uploads[0].auth.pubkey).toBe(serverKey.pubkey)
  expect(repo.abuseReports.map(({ report }) => report.domain)).toEqual(['spam.example'])
})

test('abuse@ of a domain released after the server served it reaches the admins under the server key', async () => {
  const admin = signer()
  const { repo, network, owner, serverKey, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(admin.pubkey, ['wss://inbox.admin.example/'])
  await repo.deleteDomain('example.com', owner.pubkey)

  await send(['abuse@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([admin.pubkey])
  expect(openWrap(network.published[0].event, admin.sk).seal.pubkey).toBe(serverKey.pubkey)
  expect(repo.abuseReports.map(({ report }) => report.domain)).toEqual(['example.com'])
  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 })
})

test('abuse@ of the server itself reaches the admins under the server key', async () => {
  const admin = signer()
  const { repo, network, serverKey, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(admin.pubkey, ['wss://inbox.admin.example/'])

  await send(['abuse@MX.example.org'])

  expect(openWrap(network.published[0].event, admin.sk).seal.pubkey).toBe(serverKey.pubkey)
  expect(repo.abuseReports.map(({ report }) => report.domain)).toEqual(['mx.example.org'])
  await expect(send(['bob@mx.example.org'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 })
})

test('a complaint nobody can get over Nostr is still kept on the server', async () => {
  const { repo, network, send } = await setup()
  await repo.suspendDomain('spam.example')

  const info = await send(['abuse@spam.example'])

  expect(info.response).toMatch(/Kept on this server/)
  expect(network.published).toEqual([])
  expect(repo.abuseReports.map(({ report }) => report.domain)).toEqual(['spam.example'])
})

test('a recipient without inbox relays is deferred with 450', async () => {
  const { network, bob, send } = await setup()
  network.inboxRelays.delete(bob.pubkey)

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 450 })
})

test('a message to an address with several pubkeys is wrapped to each of them', async () => {
  const { repo, network, owner, bob, send } = await setup()
  const carol = signer()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'team',
    pubkeys: [bob.pubkey, carol.pubkey],
    ownerPubkey: owner.pubkey,
  })
  network.inboxRelays.set(carol.pubkey, ['wss://inbox.carol.example/'])

  const info = await send(['team@example.com'])

  expect(info.rejected).toEqual([])
  expect(network.published.map((entry) => entry.relays)).toEqual([
    ['wss://inbox.bob.example/'],
    ['wss://inbox.carol.example/'],
  ])
  expect(openWrap(network.published[0].event, bob.sk).rumor.kind).toBe(1301)
  expect(openWrap(network.published[1].event, carol.sk).rumor.kind).toBe(1301)
})

test('an address with several pubkeys reaches those with inbox relays, and is deferred while none has any', async () => {
  const { repo, network, owner, bob, send } = await setup()
  const team = { domain: 'example.com', ownerPubkey: owner.pubkey }
  await repo.putAddress({ ...team, localPart: 'team', pubkeys: [signer().pubkey, bob.pubkey] })
  await repo.putAddress({ ...team, localPart: 'new', pubkeys: [signer().pubkey, signer().pubkey] })

  await send(['team@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([bob.pubkey])
  await expect(send(['new@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 450 })
})

test('the message is deferred with 451 when no relay takes it', async () => {
  const { network, send } = await setup()
  network.down.add('wss://inbox.bob.example/')

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EMESSAGE', responseCode: 451 })
})

test('a domain key in a bunker seals through it, keeps less inline, and defers while the bunker is away', async () => {
  const bunker = new FakeBunker()
  const { repo, network, blobs, owner, bob, send } = await setup({ bunker })
  await repo.replaceBridgeKey('example.com', owner.pubkey, bunker.bridgeKey())

  await send(['bob@example.com'])
  await send(['bob@example.com'], largeMessage(MAX_BUNKER_INLINE_MIME_BYTES))
  bunker.silent = true
  const away = send(['bob@example.com'])

  await expect(away).rejects.toMatchObject({ code: 'EMESSAGE', responseCode: 451 })
  const [small, large] = network.published
  expect(openWrap(small.event, bob.sk).seal.pubkey).toBe(bunker.key.pubkey)
  expect(small.auth.pubkey).toBe(bunker.key.pubkey)
  expect(openWrap(large.event, bob.sk).rumor.content).toBe('')
  expect(blobs.uploads.map((upload) => upload.auth.pubkey)).toEqual([bunker.key.pubkey])
  expect(network.published).toHaveLength(2)
})

test('each recipient gets a wrap sealed by the key of its own domain', async () => {
  const { repo, network, domain, bob, send } = await setup()
  const owner = signer()
  const other = await verifyDomain(repo, 'other.example', owner.pubkey)
  const dave = signer()
  await repo.putAddress({
    domain: 'other.example',
    localPart: 'dave',
    pubkeys: [dave.pubkey],
    ownerPubkey: owner.pubkey,
  })
  network.inboxRelays.set(dave.pubkey, ['wss://inbox.dave.example/'])

  await send(['bob@example.com', 'dave@other.example'])

  const toBob = openWrap(
    network.published.find((entry) => entry.event.tags[0][1] === bob.pubkey)?.event ?? fail(),
    bob.sk,
  )
  const toDave = openWrap(
    network.published.find((entry) => entry.event.tags[0][1] === dave.pubkey)?.event ?? fail(),
    dave.sk,
  )
  expect(toBob.seal.pubkey).toBe(domain.bridgePubkey)
  expect(toDave.seal.pubkey).toBe(other.bridgePubkey)
  expect(toDave.rumor.tags[0]).toEqual(toBob.rumor.tags[0])
})

test('two addresses of the same pubkey get a single wrap', async () => {
  const { network, bob, send } = await setup()

  await send(['bob@example.com', `${npubEncode(bob.pubkey)}@example.com`])

  expect(network.published).toHaveLength(1)
})

test('abuse@ reaches the domain owner and the server admins', async () => {
  const admin = signer()
  const { network, owner, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  network.inboxRelays.set(admin.pubkey, ['wss://inbox.admin.example/'])

  await send(['abuse@example.com'])

  expect(network.published.map((entry) => entry.relays)).toEqual([
    ['wss://inbox.owner.example/'],
    ['wss://inbox.admin.example/'],
  ])
  expect(openWrap(network.published[0].event, owner.sk).rumor.kind).toBe(1301)
  expect(openWrap(network.published[1].event, admin.sk).rumor.kind).toBe(1301)
})

test('a declared abuse@ reaches its pubkey too, and each pubkey once', async () => {
  const { repo, network, owner, bob, send } = await setup()
  await repo.putAddress({ domain: 'example.com', localPart: 'abuse', pubkeys: [bob.pubkey], ownerPubkey: owner.pubkey })
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])

  await send(['abuse@example.com', 'bob@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([bob.pubkey, owner.pubkey])
})

test('a disabled abuse@ still reaches the owner, but not its own pubkey', async () => {
  const { repo, network, owner, bob, send } = await setup()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'abuse',
    pubkeys: [bob.pubkey],
    ownerPubkey: owner.pubkey,
    enabled: false,
  })
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])

  await send(['abuse@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([owner.pubkey])
})

test('abuse@ goes on to the pubkeys with inbox relays and is kept anyway', async () => {
  const admin = signer()
  const { repo, network, owner, send } = await setup({ adminPubkeys: [admin.pubkey] })
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])

  await send(['abuse@example.com'])

  expect(network.published.map((entry) => entry.event.tags[0][1])).toEqual([owner.pubkey])
  expect(repo.abuseReports).toHaveLength(1)
})

test('abuse@ is taken even when nobody it reaches has inbox relays', async () => {
  const { repo, network, send } = await setup({ adminPubkeys: [signer().pubkey] })

  const info = await send(['abuse@example.com'])

  expect(info.response).toMatch(/Kept on this server/)
  expect(network.published).toEqual([])
  expect(repo.abuseReports).toHaveLength(1)
})

test('a message to abuse@ is kept on the server with its From and Subject decoded', async () => {
  const { repo, network, owner, send } = await setup()
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  const raw = MESSAGE.replace('Subject: Hello', 'Subject: =?UTF-8?Q?Spam_re=C3=A7u?=')

  await send(['abuse@example.com'], raw)
  await send(['bob@example.com'])

  expect(repo.abuseReports).toHaveLength(1)
  const [{ report, message }] = repo.abuseReports
  expect(report).toMatchObject({
    domain: 'example.com',
    mailFrom: 'alice@sender.example',
    from: 'Alice <alice@sender.example>',
    subject: 'Spam reçu',
    size: message.length,
  })
  expect(message.toString()).toMatch(/^Return-Path: <alice@sender\.example>\r\n/)
  expect(message.toString().endsWith(raw)).toBe(true)
})

test('an abuse report is kept while the relays refuse it, and once when the sender retries', async () => {
  const { repo, network, owner, send } = await setup()
  network.inboxRelays.set(owner.pubkey, ['wss://inbox.owner.example/'])
  network.down.add('wss://inbox.owner.example/')

  await expect(send(['abuse@example.com'])).rejects.toMatchObject({ responseCode: 451 })
  expect(repo.abuseReports).toHaveLength(1)

  network.down.clear()
  await send(['abuse@example.com'])

  expect(repo.abuseReports).toHaveLength(1)
})

test('a database failure defers the recipient with 451', async () => {
  const { repo, send } = await setup()
  repo.fail = true

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 451 })
})

test('a message above the inline limit is stored on Blossom and referenced from the rumor', async () => {
  const { network, blobs, domain, bob, send } = await setup()
  network.blossomServers.set(bob.pubkey, ['https://blossom.bob.example', DOMAIN_SERVER])
  const raw = largeMessage(MAX_INLINE_MIME_BYTES)

  await send(['bob@example.com'], raw)

  expect(blobs.uploads).toHaveLength(1)
  const [{ servers, blob, auth }] = blobs.uploads
  expect(domain.blossomServers).toEqual([DOMAIN_SERVER])
  expect(servers).toEqual([DOMAIN_SERVER, 'https://blossom.bob.example'])
  expect(auth.pubkey).toBe(domain.bridgePubkey)

  const { rumor } = openWrap(network.published[0].event, bob.sk)
  expect(rumor.content).toBe('')
  expect(rumor.tags.slice(2)).toEqual([
    ['x', blob.sha256],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', blob.key],
    ['decryption-nonce', blob.nonce],
  ])

  const mime = decryptBlob(blob.bytes, rumor)
  expect(mime).toMatch(/^Return-Path: <alice@sender\.example>\r\nReceived-SPF: /)
  expect(mime.endsWith(raw)).toBe(true)
})

test('every recipient references the same blob', async () => {
  const { repo, network, blobs, domain, bob, send } = await setup()
  const carol = signer()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'carol',
    pubkeys: [carol.pubkey],
    ownerPubkey: domain.pubkey,
  })
  network.inboxRelays.set(carol.pubkey, ['wss://inbox.carol.example/'])

  await send(['bob@example.com', 'carol@example.com'], largeMessage(MAX_INLINE_MIME_BYTES))

  expect(blobs.uploads).toHaveLength(1)
  const tagsOf = (secretKey: Uint8Array, pubkey: string) =>
    openWrap(network.published.find((entry) => entry.event.tags[0][1] === pubkey)?.event ?? fail(), secretKey).rumor
      .tags
  expect(tagsOf(carol.sk, carol.pubkey)).toEqual(tagsOf(bob.sk, bob.pubkey))
})

test('a message under the inline limit does not touch Blossom', async () => {
  const { blobs, send } = await setup()

  await send(['bob@example.com'])

  expect(blobs.uploads).toHaveLength(0)
})

test('the message is deferred with 451 when no Blossom server stores it', async () => {
  const { network, blobs, send } = await setup()
  blobs.down.add(DOMAIN_SERVER)

  await expect(send(['bob@example.com'], largeMessage(MAX_INLINE_MIME_BYTES))).rejects.toMatchObject({
    code: 'EMESSAGE',
    responseCode: 451,
  })
  expect(network.published).toHaveLength(0)
})

test('a message over the size limit is refused with 552 after DATA', async () => {
  const { network, blobs, port } = await setup()
  const line = 'x'.repeat(76)
  const body = Array.from({ length: Math.ceil(MAX_MESSAGE_BYTES / line.length) + 1 }, () => line).join('\r\n')

  const replies = await converse(port, [
    'EHLO client.example',
    'MAIL FROM:<alice@sender.example>',
    'RCPT TO:<bob@example.com>',
    'DATA',
    `Subject: Big\r\n\r\n${body}\r\n.`,
    'QUIT',
  ])

  expect(replies[4]).toMatch(/^354 /)
  expect(replies[5]).toMatch(/^552 /)
  expect(network.published).toHaveLength(0)
  expect(blobs.uploads).toHaveLength(0)
})

test('STARTTLS is offered only with a certificate', async () => {
  const plain = await setup()
  const secured = await setup({ tls: await readFixtureTls('a') })

  const [, plainEhlo] = await converse(plain.port, ['EHLO client.example', 'QUIT'])
  const [, securedEhlo] = await converse(secured.port, ['EHLO client.example', 'QUIT'])

  expect(plainEhlo).not.toMatch(/STARTTLS/)
  expect(securedEhlo).toMatch(/^250[- ]STARTTLS\r$/m)
})

test('a message sent over STARTTLS is delivered and traced as ESMTPS', async () => {
  const { network, bob, port } = await setup({ tls: await readFixtureTls('a') })
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: false },
  })
  cleanups.push(async () => transport.close())

  await transport.sendMail({ envelope: { from: 'alice@sender.example', to: ['bob@example.com'] }, raw: MESSAGE })

  const [{ event }] = network.published
  const { rumor } = openWrap(event, bob.sk)
  expect(rumor.content).toMatch(/\tby mx\.example\.org with ESMTPS id /)
})

test('SPF, DKIM and DMARC results are added above the Received line', async () => {
  const { network, authDns, bob, send } = await setup()
  const { raw } = await authenticSender(authDns, 'v=DMARC1; p=reject')

  await send(['bob@example.com'], raw)

  const { content } = openWrap(network.published[0].event, bob.sk).rumor
  expect(content).toMatch(/^Return-Path: <alice@sender\.example>\r\nReceived-SPF: pass /)
  const results = content.slice(content.indexOf('Authentication-Results: '), content.indexOf('Received: from'))
  expect(results).toMatch(/^Authentication-Results: mx\.example\.org;/)
  expect(results).toMatch(/dkim=pass header\.i=@sender\.example header\.s=mail/)
  expect(results).toMatch(/spf=pass .+ smtp\.mailfrom=alice@sender\.example/)
  expect(results).toMatch(/dmarc=pass \(p=REJECT/)
  expect(content.endsWith(raw)).toBe(true)
})

test('a message failing DMARC under p=reject is refused with 550', async () => {
  const { network, authDns, send } = await setup()
  forgedSender(authDns, 'v=DMARC1; p=reject')

  await expect(send(['bob@example.com'])).rejects.toMatchObject({
    code: 'EMESSAGE',
    responseCode: 550,
    response: expect.stringMatching(/^550 5\.7\.1 The DMARC policy of sender\.example rejects this message/),
  })
  expect(network.published).toHaveLength(0)
})

test('a message failing DMARC under p=reject while SPF times out is deferred with 451', async () => {
  const { network, authDns, send } = await setup()
  forgedSender(authDns, 'v=DMARC1; p=reject')
  authDns.timingOut.add('sender.example')

  await expect(send(['bob@example.com'])).rejects.toMatchObject({
    code: 'EMESSAGE',
    responseCode: 451,
    response: expect.stringMatching(/^451 4\.7\.0 The DMARC policy of sender\.example could not be checked/),
  })
  expect(network.published).toHaveLength(0)
})

test.each(['p=quarantine', 'p=none', 'p=reject; t=y'])(
  'a message failing DMARC under %s is delivered with its results',
  async (policy) => {
    const { network, authDns, bob, send } = await setup()
    forgedSender(authDns, `v=DMARC1; ${policy}`)

    await send(['bob@example.com'])

    const { content } = openWrap(network.published[0].event, bob.sk).rumor
    expect(content).toMatch(/spf=fail /)
    expect(content).toMatch(/dmarc=fail /)
  },
)

test('results that came with the message under the name of the server are removed', async () => {
  const { network, bob, send } = await setup()
  const forged = 'Authentication-Results: mx.example.org;\r\n dkim=pass header.d=bank.example\r\n'
  const relayed = 'Authentication-Results: relay.example; spf=pass smtp.mailfrom=sender.example\r\n'

  await send(['bob@example.com'], forged + relayed + MESSAGE)

  const { content } = openWrap(network.published[0].event, bob.sk).rumor
  expect(content.match(/^Authentication-Results: mx\.example\.org;/gm)).toHaveLength(1)
  expect(content).not.toContain('bank.example')
  expect(content.endsWith(relayed + MESSAGE)).toBe(true)
})

// sender.example lets 127.0.0.1 send and signs MESSAGE with its DKIM key.
async function authenticSender(authDns: FakeAuthDns, dmarc: string): Promise<{ raw: string }> {
  const { publicKey, privateKey } = await generateDkimKeyPair()
  authDns.txtRecords.set('sender.example', ['v=spf1 ip4:127.0.0.1 -all'])
  authDns.txtRecords.set('mail._domainkey.sender.example', [`v=DKIM1; k=rsa; p=${publicKey}`])
  authDns.txtRecords.set('_dmarc.sender.example', [dmarc])

  const { signatures } = await dkimSign(MESSAGE, {
    signatureData: [{ signingDomain: 'sender.example', selector: 'mail', privateKey }],
  })
  return { raw: signatures + MESSAGE }
}

// sender.example does not let 127.0.0.1 send and MESSAGE carries no signature.
function forgedSender(authDns: FakeAuthDns, dmarc: string): void {
  authDns.txtRecords.set('sender.example', ['v=spf1 ip4:192.0.2.1 -all'])
  authDns.txtRecords.set('_dmarc.sender.example', [dmarc])
}

function largeMessage(bytes: number): string {
  const line = 'y'.repeat(76)
  const lines = Array.from({ length: Math.ceil(bytes / line.length) }, () => line)
  return [MESSAGE.split('\r\n\r\n')[0], '', ...lines, ''].join('\r\n')
}

// The client side of Nostr Mail large MIME.
function decryptBlob(bytes: Buffer, rumor: NostrEvent): string {
  const tag = (name: string) => Buffer.from(rumor.tags.find((entry) => entry[0] === name)?.[1] ?? '', 'base64')
  const decipher = createDecipheriv('aes-256-gcm', tag('decryption-key'), tag('decryption-nonce'))
  decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8')
}

// Sends each command once the previous reply is complete and returns every reply, greeting first.
test('a new size limit applies from the next connection', async () => {
  const { network, port, settings } = await setup()
  await settings.update({ maxMessageBytes: 128 * 1024 })
  const body = 'x'
    .repeat(76)
    .concat('\r\n')
    .repeat(Math.ceil((160 * 1024) / 78))

  const replies = await converse(port, [
    'EHLO client.example',
    'MAIL FROM:<alice@sender.example>',
    'RCPT TO:<bob@example.com>',
    'DATA',
    `Subject: Big\r\n\r\n${body}.`,
    'QUIT',
  ])

  expect(replies[1]).toContain('SIZE 131072')
  expect(replies[5]).toMatch(/^552 5\.3\.4 Messages are limited to 131072 bytes/)
  expect(network.published).toHaveLength(0)
})

async function converse(port: number, commands: string[]): Promise<string[]> {
  const socket = connect(port, '127.0.0.1')
  const reply = replyReader(socket)

  const replies = [await reply()]
  for (const command of commands) {
    socket.write(`${command}\r\n`)
    replies.push(await reply())
  }
  socket.end()
  return replies
}

function fail(): never {
  throw new Error('No wrap was published to this recipient')
}
