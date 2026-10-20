import { npubEncode } from 'nostr-tools/nip19'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  type App,
  claim,
  domainConfig,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  signer,
  verifyDomain,
} from './helpers.js'

const PUBKEY = 'a'.repeat(64)

async function setup() {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, domainConfig, new FakeDns(), new FakeRelayNetwork())
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  await repo.putAddress({ domain: 'example.com', localPart: 'alice', pubkey: PUBKEY, ownerPubkey: owner.pubkey })
  return { repo, app }
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

test('the name is required', async () => {
  const { app } = await setup()

  const response = await lookup(app, 'example.com', '')

  expect(response.statusCode).toBe(400)
  expect(response.headers['access-control-allow-origin']).toBe('*')
  expect(response.json()).toEqual({ error: 'name_required' })

  await app.close()
})
