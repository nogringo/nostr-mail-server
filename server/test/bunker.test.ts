import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { expect, test } from 'vitest'
import { BUNKER_PERMISSIONS, BunkerError, DomainSigners, parseBunkerUrl } from '../src/bunker.js'
import { SignerRefusal, SignerUnavailable, unwrapWith, wrapWith } from '../src/signer.js'
import { BUNKER_RELAY, FakeBunker, keySigner, openWrap, signer } from './helpers.js'

const LIST = { kind: 10002, created_at: 0, tags: [], content: '' }

function signers(bunker: FakeBunker) {
  return new DomainSigners({ open: bunker.open, timeoutMs: 50, connectTimeoutMs: 50 })
}

function pointerOf(bunker: FakeBunker) {
  const pointer = parseBunkerUrl(bunker.url)
  if (!pointer) throw new Error('The URL of the fake bunker does not parse')
  return pointer
}

test('a bunker URL needs a pubkey and a public wss relay', () => {
  const pubkey = 'a'.repeat(64)
  const url = `bunker://${pubkey}?relay=wss%3A%2F%2FRelay.Example.org&relay=ws://plain.example.org&relay=wss://127.0.0.1`

  expect(parseBunkerUrl(` ${url}&secret=abc `)).toEqual({ pubkey, relays: ['wss://relay.example.org/'], secret: 'abc' })
  expect(parseBunkerUrl(url)?.secret).toBeNull()
  for (const refused of [
    `bunker://${pubkey}`,
    `bunker://${pubkey}?relay=ws://relay.example.org`,
    'bunker://npub1abc?relay=wss://relay.example.org',
    `nostrconnect://${pubkey}?relay=wss://relay.example.org`,
    'bob@example.com',
    42,
  ]) {
    expect(parseBunkerUrl(refused)).toBeNull()
  }
})

test('connecting asks for the permissions with the secret, then checks NIP-44 both ways', async () => {
  const bunker = new FakeBunker()

  const connected = await signers(bunker).connect(pointerOf(bunker))

  expect(connected).toEqual({
    pubkey: bunker.key.pubkey,
    bunker: { signerPubkey: bunker.signerKey.pubkey, relays: [BUNKER_RELAY], clientKey: expect.any(String) },
  })
  expect(bunker.methods()).toEqual(['connect', 'get_public_key', 'nip44_encrypt', 'nip44_decrypt'])
  expect(bunker.requests[0].params).toEqual([bunker.signerKey.pubkey, 's3cret', BUNKER_PERMISSIONS])
  const clientPubkey = getPublicKey(hexToBytes(connected.bunker.clientKey))
  expect(bunker.requests.every((request) => request.clientPubkey === clientPubkey)).toBe(true)
  expect(bunker.closed).toBe(1)
})

test.each([
  ['does not answer', (bunker: FakeBunker) => Object.assign(bunker, { silent: true }), 'bunker_timeout'],
  ['refuses', (bunker: FakeBunker) => Object.assign(bunker, { refusing: 'unauthorized' }), 'bunker_refused'],
  [
    'wants an approval in a browser',
    (bunker: FakeBunker) => Object.assign(bunker, { authUrl: 'https://bunker.example.org/approve' }),
    'bunker_auth_url',
  ],
])('a bunker that %s is not connected', async (_, prepare, code) => {
  const bunker = new FakeBunker()
  prepare(bunker)

  const connecting = signers(bunker).connect(pointerOf(bunker))

  await expect(connecting).rejects.toThrow(BunkerError)
  await expect(connecting).rejects.toMatchObject({ code })
  expect(bunker.closed).toBe(1)
})

test('a domain key in a bunker writes and opens gift wraps through it, over one connection', async () => {
  const bunker = new FakeBunker()
  const registry = signers(bunker)
  const domain = bunker.bridgeKey()
  const bob = signer()

  const domainKey = registry.forDomain(domain)
  const { seal, rumor } = openWrap(
    await wrapWith(domainKey, { kind: 1301, tags: [], content: 'Hi' }, bob.pubkey),
    bob.sk,
  )
  const reply = await wrapWith(keySigner(bob), { kind: 1301, tags: [], content: 'Re' }, domain.bridgePubkey)
  const opened = await unwrapWith(domainKey, reply)

  expect(registry.forDomain({ ...domain })).toBe(domainKey)
  expect(domainKey.pubkey).toBe(bunker.key.pubkey)
  expect(seal.pubkey).toBe(bunker.key.pubkey)
  expect(rumor).toMatchObject({ kind: 1301, pubkey: bunker.key.pubkey, content: 'Hi' })
  expect(opened).toMatchObject({ pubkey: bob.pubkey, content: 'Re' })
  expect(bunker.opened).toEqual([{ pubkey: bunker.signerKey.pubkey, relays: [BUNKER_RELAY], secret: null }])
  const clientPubkey = getPublicKey(hexToBytes(bunker.clientKey))
  expect(bunker.requests.every((request) => request.clientPubkey === clientPubkey)).toBe(true)
  await registry.close()
  expect(bunker.closed).toBe(1)
})

test('a bunker that stops answering is asked again over a new connection', async () => {
  const bunker = new FakeBunker()
  const domainKey = signers(bunker).forDomain(bunker.bridgeKey())

  bunker.silent = true
  await expect(domainKey.signEvent(LIST)).rejects.toThrow(SignerUnavailable)
  bunker.silent = false
  const signed = await domainKey.signEvent(LIST)

  expect(signed.pubkey).toBe(bunker.key.pubkey)
  expect(bunker.opened).toHaveLength(2)
  expect(bunker.closed).toBe(1)
})

test('what a bunker refuses, signs with another key or cannot carry is refused for good', async () => {
  const bunker = new FakeBunker()
  const registry = signers(bunker)
  const domainKey = registry.forDomain(bunker.bridgeKey())
  const impostor = registry.forDomain({ ...bunker.bridgeKey(), bridgePubkey: signer().pubkey })

  bunker.refusing = 'unauthorized'
  await expect(domainKey.nip44Decrypt(signer().pubkey, 'abc')).rejects.toThrow(SignerRefusal)
  bunker.refusing = null
  await expect(impostor.signEvent(LIST)).rejects.toThrow(SignerRefusal)
  const asked = bunker.requests.length
  await expect(domainKey.nip44Decrypt(signer().pubkey, 'x'.repeat(70_000))).rejects.toThrow(SignerRefusal)

  expect(bunker.requests).toHaveLength(asked)
})

test('a key moved between the server and a bunker gets a new signer', async () => {
  const bunker = new FakeBunker()
  const registry = signers(bunker)
  const held = {
    ...bunker.bridgeKey(),
    bridgePrivateKey: Buffer.from(bunker.key.sk).toString('hex'),
    bridgeBunker: null,
  }

  const local = registry.forDomain(held)
  const remote = registry.forDomain(bunker.bridgeKey())
  await remote.signEvent(LIST)
  const back = registry.forDomain(held)

  expect(remote).not.toBe(local)
  expect(back).not.toBe(remote)
  expect((await back.signEvent(LIST)).pubkey).toBe(bunker.key.pubkey)
  expect(bunker.methods()).toEqual(['sign_event'])
  expect(bunker.closed).toBe(1)
})
