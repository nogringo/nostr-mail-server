import { npubEncode } from 'nostr-tools/nip19'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  type App,
  apiConfig,
  claim,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

const PUBKEY = 'a'.repeat(64)

async function setup() {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  await repo.putAddress({ domain: 'example.com', localPart: 'alice', pubkey: PUBKEY, ownerPubkey: owner.pubkey })
  return { repo, app, owner }
}

function lookup(app: App, host: string, query: string) {
  return app.inject({ method: 'GET', url: `/.well-known/nostr.json${query}`, headers: { host } })
}

test('a declared address resolves on its domain, with CORS open', async () => {
  const { app } = await setup()

  const response = await lookup(app, 'Example.com:443', '?name=Alice')

  expect(response.statusCode).toBe(200)
  expect(response.headers['access-control-allow-origin']).toBe('*')
  expect(response.json()).toEqual({ names: { alice: PUBKEY } })

  await app.close()
})

test('_smtp resolves to the own key of each domain', async () => {
  const { repo, app } = await setup()
  const other = await verifyDomain(repo, 'other.example', signer().pubkey)
  const example = await repo.findVerifiedDomain('example.com')

  const first = await lookup(app, 'example.com', '?name=_smtp')
  const second = await lookup(app, 'other.example', '?name=_smtp')

  expect(first.json()).toEqual({ names: { _smtp: example?.bridgePubkey } })
  expect(second.json()).toEqual({ names: { _smtp: other.bridgePubkey } })
  expect(other.bridgePubkey).not.toBe(example?.bridgePubkey)

  await app.close()
})

test('an npub local part resolves without a stored address', async () => {
  const { app } = await setup()
  const name = npubEncode(PUBKEY)

  const response = await lookup(app, 'example.com', `?name=${name}`)

  expect(response.json()).toEqual({ names: { [name]: PUBKEY } })

  await app.close()
})

test.each([{ private: true }, { enabled: false }])('an address with %j does not show its pubkey', async (settings) => {
  const { repo, app, owner } = await setup()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'shop',
    pubkey: PUBKEY,
    ownerPubkey: owner.pubkey,
    ...settings,
  })

  const response = await lookup(app, 'example.com', '?name=shop')

  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ names: {} })

  await app.close()
})

test('an unknown name returns no names', async () => {
  const { app } = await setup()

  for (const name of ['bob', 'a..b', 'npub1typo', PUBKEY]) {
    const response = await lookup(app, 'example.com', `?name=${name}`)
    expect(response.statusCode, name).toBe(200)
    expect(response.json(), name).toEqual({ names: {} })
  }

  await app.close()
})

test('a domain that is not verified resolves nothing', async () => {
  const { repo, app } = await setup()
  await repo.createDomain(claim('pending.example', PUBKEY))

  for (const host of ['pending.example', 'unknown.example', 'localhost']) {
    for (const name of ['_smtp', npubEncode(PUBKEY), 'alice']) {
      expect((await lookup(app, host, `?name=${name}`)).json(), `${name}@${host}`).toEqual({ names: {} })
    }
  }

  await app.close()
})

test('a suspended domain resolves nothing', async () => {
  const { repo, app } = await setup()
  await repo.suspendDomain('example.com')

  for (const name of ['_smtp', npubEncode(PUBKEY), 'alice']) {
    expect((await lookup(app, 'example.com', `?name=${name}`)).json(), name).toEqual({ names: {} })
  }

  await app.close()
})

test('a domain relayed by its own website resolves on its path, whatever the Host', async () => {
  const { repo, app, owner } = await setup()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'shop',
    pubkey: PUBKEY,
    ownerPubkey: owner.pubkey,
    private: true,
  })
  const relayed = (path: string) => app.inject({ method: 'GET', url: path, headers: { host: 'mail.example.org' } })

  const alice = await relayed('/nip05/Example.com?name=alice')
  const shop = await relayed('/nip05/example.com?name=shop')
  const unknown = await relayed('/nip05/unknown.example?name=alice')
  const unnamed = await relayed('/nip05/example.com')

  expect(alice.statusCode).toBe(200)
  expect(alice.headers['access-control-allow-origin']).toBe('*')
  expect(alice.json()).toEqual({ names: { alice: PUBKEY } })
  expect(shop.json()).toEqual({ names: {} })
  expect(unknown.json()).toEqual({ names: {} })
  expect(unnamed.statusCode).toBe(400)

  await app.close()
})

test('the name is required', async () => {
  const { app } = await setup()

  const response = await lookup(app, 'example.com', '')

  expect(response.statusCode).toBe(400)
  expect(response.headers['access-control-allow-origin']).toBe('*')
  expect(response.json()).toEqual({ error: 'name_required' })

  await app.close()
})
