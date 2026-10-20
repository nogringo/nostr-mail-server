import { type AddressInfo, connect } from 'node:net'
import nodemailer from 'nodemailer'
import { npubEncode } from 'nostr-tools/nip19'
import { afterEach, expect, test } from 'vitest'
import { MAX_INLINE_MIME_BYTES } from '../src/inbound.js'
import { createSmtpServer } from '../src/smtp.js'
import { claim, FakeRelayNetwork, MemoryDomainRepository, openWrap, signer, verifyDomain } from './helpers.js'

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

async function setup() {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const server = createSmtpServer(repo, network, { mxHost: 'mx.example.org' })
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

  return { repo, network, port, domain, bob, send }
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

test('a message over the inline limit is refused with 552 after DATA', async () => {
  const { network, port } = await setup()
  const line = 'x'.repeat(76)
  const body = Array.from({ length: Math.ceil(MAX_INLINE_MIME_BYTES / line.length) + 1 }, () => line).join('\r\n')

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
})

const FINAL_LINE = /^\d{3} .*\r\n/m

// Sends each command once the previous reply is complete and returns every reply, greeting first.
async function converse(port: number, commands: string[]): Promise<string[]> {
  const socket = connect(port, '127.0.0.1').setEncoding('utf8')
  let buffer = ''
  let notify = () => {}
  socket.on('data', (chunk: string) => {
    buffer += chunk
    notify()
  })

  const reply = async (): Promise<string> => {
    let end = FINAL_LINE.exec(buffer)
    while (!end) {
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      end = FINAL_LINE.exec(buffer)
    }
    const text = buffer.slice(0, end.index + end[0].length)
    buffer = buffer.slice(text.length)
    return text
  }

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
