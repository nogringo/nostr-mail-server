import { createDecipheriv } from 'node:crypto'
import { type AddressInfo, connect } from 'node:net'
import nodemailer from 'nodemailer'
import { npubEncode } from 'nostr-tools/nip19'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, expect, test } from 'vitest'
import { MAX_INLINE_MIME_BYTES } from '../src/inbound.js'
import { createSmtpServer } from '../src/smtp.js'
import type { TlsCredentials } from '../src/tls.js'
import {
  claim,
  FakeBlobStore,
  FakeRelayNetwork,
  MemoryDomainRepository,
  openWrap,
  readFixtureTls,
  replyReader,
  signer,
  verifyDomain,
} from './helpers.js'

const MAX_MESSAGE_BYTES = 256 * 1024
const DOMAIN_SERVER = 'https://blossom.example.org'

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

async function setup({ tls }: { tls?: TlsCredentials } = {}) {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const blobs = new FakeBlobStore()
  const server = createSmtpServer(
    repo,
    network,
    blobs,
    { mxHost: 'mx.example.org', maxMessageBytes: MAX_MESSAGE_BYTES },
    { tls },
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
  await repo.putAddress({ domain: 'example.com', localPart: 'bob', pubkey: bob.pubkey, ownerPubkey: owner.pubkey })
  network.dmRelays.set(bob.pubkey, ['wss://inbox.bob.example/'])

  const send = (to: string[], raw = MESSAGE) =>
    transport.sendMail({ envelope: { from: 'alice@sender.example', to }, raw })

  return { repo, network, blobs, port, domain, bob, send }
}

test('a message to a declared address is gift wrapped to its pubkey and published', async () => {
  const { network, domain, bob, send } = await setup()

  const info = await send(['Bob@Example.com'])

  expect(info.rejected).toEqual([])
  expect(network.published).toHaveLength(1)
  const [{ relays, event, authKey }] = network.published
  expect(relays).toEqual(['wss://inbox.bob.example/'])
  expect(event.kind).toBe(1059)
  expect(event.tags).toEqual([['p', bob.pubkey]])
  expect(Buffer.from(authKey).toString('hex')).toBe(domain.bridgePrivateKey)

  const { seal, rumor } = openWrap(event, bob.sk)
  expect(seal.pubkey).toBe(domain.bridgePubkey)
  expect(rumor.pubkey).toBe(domain.bridgePubkey)
  expect(rumor.kind).toBe(1301)
  expect(rumor.tags).toEqual([
    ['email-id', expect.stringMatching(/^[0-9a-f]{64}$/)],
    ['mail-from', 'alice@sender.example'],
  ])
  expect(rumor.content).toMatch(
    /^Return-Path: <alice@sender\.example>\r\nReceived: from .+\r\n\tby mx\.example\.org with ESMTP id \w+;\r\n\t.+ \+0000\r\n/,
  )
  expect(rumor.content.endsWith(MESSAGE)).toBe(true)
})

test('an npub address is delivered without being declared', async () => {
  const { network, send } = await setup()
  const carol = signer()
  network.dmRelays.set(carol.pubkey, ['wss://inbox.carol.example/'])

  await send([`${npubEncode(carol.pubkey)}@example.com`])

  expect(openWrap(network.published[0].event, carol.sk).rumor.kind).toBe(1301)
})

test.each(['nobody@example.com', '_smtp@example.com', 'bob@unknown.example', 'bob@pending.example'])(
  '%s is refused with 550',
  async (address) => {
    const { repo, send } = await setup()
    await repo.createDomain(claim('pending.example', signer().pubkey))

    await expect(send([address])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 })
  },
)

test('the known recipients still get the message when others are refused', async () => {
  const { network, send } = await setup()

  const info = await send(['bob@example.com', 'nobody@example.com'])

  expect(info.accepted).toEqual(['bob@example.com'])
  expect(info.rejected).toEqual(['nobody@example.com'])
  expect(network.published).toHaveLength(1)
})

test('a recipient without DM relays is deferred with 450', async () => {
  const { network, bob, send } = await setup()
  network.dmRelays.delete(bob.pubkey)

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 450 })
})

test('the message is deferred with 451 when no relay takes it', async () => {
  const { network, send } = await setup()
  network.down.add('wss://inbox.bob.example/')

  await expect(send(['bob@example.com'])).rejects.toMatchObject({ code: 'EMESSAGE', responseCode: 451 })
})

test('each recipient gets a wrap sealed by the key of its own domain', async () => {
  const { repo, network, domain, bob, send } = await setup()
  const owner = signer()
  const other = await verifyDomain(repo, 'other.example', owner.pubkey)
  const dave = signer()
  await repo.putAddress({ domain: 'other.example', localPart: 'dave', pubkey: dave.pubkey, ownerPubkey: owner.pubkey })
  network.dmRelays.set(dave.pubkey, ['wss://inbox.dave.example/'])

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
  const [{ servers, blob, authKey }] = blobs.uploads
  expect(domain.blossomServers).toEqual([DOMAIN_SERVER])
  expect(servers).toEqual([DOMAIN_SERVER, 'https://blossom.bob.example'])
  expect(Buffer.from(authKey).toString('hex')).toBe(domain.bridgePrivateKey)

  const { rumor } = openWrap(network.published[0].event, bob.sk)
  expect(rumor.content).toBe('')
  expect(rumor.tags.slice(2)).toEqual([
    ['x', blob.sha256],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', blob.key],
    ['decryption-nonce', blob.nonce],
  ])

  const mime = decryptBlob(blob.bytes, rumor)
  expect(mime).toMatch(/^Return-Path: <alice@sender\.example>\r\nReceived: /)
  expect(mime.endsWith(raw)).toBe(true)
})

test('every recipient references the same blob', async () => {
  const { repo, network, blobs, domain, bob, send } = await setup()
  const carol = signer()
  await repo.putAddress({ domain: 'example.com', localPart: 'carol', pubkey: carol.pubkey, ownerPubkey: domain.pubkey })
  network.dmRelays.set(carol.pubkey, ['wss://inbox.carol.example/'])

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

test('a message over MAX_MESSAGE_BYTES is refused with 552 after DATA', async () => {
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
