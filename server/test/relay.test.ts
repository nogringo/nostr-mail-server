import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { expect, test } from 'vitest'
import type { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import type { DeliveryResult, MailTransport } from '../src/delivery.js'
import { registerRelayRoutes } from '../src/handlers/relay.js'
import { Outbox } from '../src/outbox.js'
import { SignerUnavailable } from '../src/signer.js'
import {
  apiConfig,
  FakeBlobStore,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  outboundWrap,
  sendingDomain,
  settingsStore,
  signer,
} from './helpers.js'

const NO_DELIVERY: MailTransport = {
  deliver: async (_, __, recipients) =>
    new Map<string, DeliveryResult>(recipients.map((recipient) => [recipient, { status: 'deferred', response: '' }])),
}

async function setup(outbox?: Pick<Outbox, 'receive'>) {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const settings = settingsStore(repo)
  const app = buildApp(repo, apiConfig, new FakeDns(), network, settings)
  const logger = { info: () => {}, error: () => {} }
  registerRelayRoutes(
    app,
    repo,
    outbox ?? new Outbox(repo, network, new FakeBlobStore(), NO_DELIVERY, settings, logger),
  )
  await app.ready()
  const domain = await sendingDomain(repo, 'example.com', signer().pubkey)
  const socket = await app.injectWS('/')
  return { repo, app, domain, socket }
}

function exchange(socket: WebSocket, message: unknown): Promise<unknown> {
  const reply = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(String(data)))))
  socket.send(typeof message === 'string' ? message : JSON.stringify(message))
  return reply
}

function giftWrap(tags: string[][], overrides: Partial<NostrEvent> = {}): NostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: Math.floor(Date.now() / 1000), content: '', tags, ...overrides },
    signer().sk,
  )
}

test('a wrap to a domain key is queued, and acknowledged', async () => {
  const { repo, app, domain, socket } = await setup()
  const wrap = outboundWrap(signer(), domain.bridgePubkey)

  expect(await exchange(socket, ['EVENT', wrap])).toEqual(['OK', wrap.id, true, ''])
  expect(await exchange(socket, ['EVENT', wrap])).toEqual(['OK', wrap.id, true, ''])

  expect(repo.outbound.get(wrap.id)?.recipients.has('bob@remote.example')).toBe(true)
  socket.terminate()
  await app.close()
})

test('a wrap the server refuses is answered with the reason', async () => {
  const { repo, app, domain, socket } = await setup()
  const wrap = outboundWrap(signer(), domain.bridgePubkey, { mailFrom: 'bob@example.com' })

  expect(await exchange(socket, ['EVENT', wrap])).toEqual([
    'OK',
    wrap.id,
    false,
    'blocked: bob@example.com is not an address of the sender',
  ])
  expect(repo.outbound.get(wrap.id)?.refusal).toBe('bob@example.com is not an address of the sender')
  socket.terminate()
  await app.close()
})

test('only signed gift wraps to a domain of the server are taken', async () => {
  const { app, domain, socket } = await setup()
  const note = finalizeEvent({ kind: 1, created_at: 0, content: 'Hi', tags: [] }, signer().sk)
  const elsewhere = giftWrap([['p', signer().pubkey]])
  const untagged = giftWrap([])
  const future = giftWrap([['p', domain.bridgePubkey]], { created_at: Math.floor(Date.now() / 1000) + 7200 })
  const stale = giftWrap([['p', domain.bridgePubkey]], { created_at: Math.floor(Date.now() / 1000) - 7 * 24 * 3600 })
  const forged = { ...outboundWrap(signer(), domain.bridgePubkey), content: 'forged' }

  expect(await exchange(socket, ['EVENT', note])).toEqual([
    'OK',
    note.id,
    false,
    'blocked: this relay only takes gift wraps',
  ])
  for (const wrap of [elsewhere, untagged]) {
    expect(await exchange(socket, ['EVENT', wrap])).toEqual([
      'OK',
      wrap.id,
      false,
      'blocked: not addressed to a domain of this server',
    ])
  }
  expect(await exchange(socket, ['EVENT', future])).toEqual(['OK', future.id, false, 'invalid: dated in the future'])
  expect(await exchange(socket, ['EVENT', stale])).toEqual(['OK', stale.id, false, 'invalid: dated too far back'])
  expect(await exchange(socket, ['EVENT', forged])).toEqual(['OK', forged.id, false, 'invalid: bad id or signature'])
  expect(await exchange(socket, ['EVENT', { id: 'x' }])).toEqual(['NOTICE', 'invalid: not an event'])
  socket.terminate()
  await app.close()
})

test('a wrap that cannot be checked now is to be sent again later', async () => {
  const outbox = {
    receive: async () => {
      throw new SignerUnavailable('The bunker did not answer')
    },
  }
  const { app, domain, socket } = await setup(outbox)
  const wrap = outboundWrap(signer(), domain.bridgePubkey)

  expect(await exchange(socket, ['EVENT', wrap])).toEqual([
    'OK',
    wrap.id,
    false,
    'rate-limited: the email cannot be taken now, try again later',
  ])
  socket.terminate()
  await app.close()
})

test('the relay serves nothing', async () => {
  const { app, socket } = await setup()

  expect(await exchange(socket, ['REQ', 'mail', { kinds: [1059] }])).toEqual([
    'CLOSED',
    'mail',
    'blocked: this relay only takes the mail to send',
  ])
  expect(await exchange(socket, ['COUNT', 'mail', {}])).toEqual([
    'NOTICE',
    'invalid: this relay only takes EVENT messages',
  ])
  expect(await exchange(socket, 'not json')).toEqual(['NOTICE', 'invalid: not a NIP-01 message'])
  socket.terminate()
  await app.close()
})
