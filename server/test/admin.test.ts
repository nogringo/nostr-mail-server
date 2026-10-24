import { npubEncode } from 'nostr-tools/nip19'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  apiConfig,
  claim,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  request,
  settingsStore,
  signer,
  testSettings,
  verifyDomain,
} from './helpers.js'

function setup() {
  const repo = new MemoryDomainRepository()
  const admin = signer()
  const dns = new FakeDns()
  const network = new FakeRelayNetwork()
  const app = buildApp(repo, { ...apiConfig, adminPubkeys: [admin.pubkey] }, dns, network, settingsStore(repo))
  return { repo, app, admin, dns, network }
}

test('GET /admin/domains lists every claim of every key with its address count', async () => {
  const { repo, app, admin } = setup()
  const alice = signer()
  const bob = signer()
  const verified = await verifyDomain(repo, 'example.com', alice.pubkey)
  await repo.putAddress({ domain: 'example.com', localPart: 'bob', pubkeys: [bob.pubkey], ownerPubkey: alice.pubkey })
  await repo.putAddress({ domain: 'example.com', localPart: 'zoe', pubkeys: [bob.pubkey], ownerPubkey: alice.pubkey })
  await repo.createDomain(claim('pending.example', bob.pubkey))

  const response = await request(app, admin, 'GET', '/admin/domains')

  expect(response.statusCode).toBe(200)
  expect(response.json().suspensions).toEqual([])
  expect(response.json().allowedKeys).toEqual([])
  expect(response.json().settings).toEqual(testSettings)
  expect(response.json().domains).toEqual([
    {
      domain: 'example.com',
      pubkey: alice.pubkey,
      verifiedAt: verified.verifiedAt,
      checkedAt: verified.checkedAt,
      createdAt: verified.createdAt,
      shared: false,
      addressCount: 2,
      checks: verified.checks,
    },
    {
      domain: 'pending.example',
      pubkey: bob.pubkey,
      verifiedAt: null,
      checkedAt: null,
      createdAt: expect.any(String),
      shared: false,
      addressCount: 0,
      checks: null,
    },
  ])

  await app.close()
})

test('GET /admin/domains checks the DNS records of the server itself', async () => {
  const { app, admin, dns } = setup()
  dns.addressRecords.set('mx.example.org', ['192.0.2.10'])
  dns.ptrRecords.set('192.0.2.10', ['vps-123.provider.example'])

  const response = await request(app, admin, 'GET', '/admin/domains')

  expect(response.statusCode).toBe(200)
  expect(response.json().serverRecords).toEqual([
    {
      id: 'host',
      type: 'A',
      name: 'mx.example.org',
      value: '192.0.2.10',
      check: { status: 'ok', found: ['192.0.2.10'] },
    },
    {
      id: 'ptr',
      type: 'PTR',
      name: '192.0.2.10',
      value: 'mx.example.org',
      check: { status: 'mismatch', found: ['vps-123.provider.example'] },
    },
    {
      id: 'spf',
      type: 'TXT',
      name: '_spf.example.org',
      value: 'v=spf1 ip4:192.0.2.10 -all',
      check: { status: 'missing', found: [] },
    },
  ])

  await app.close()
})

test('the private keys are never returned to an admin', async () => {
  const { repo, app, admin } = setup()
  const stored = await verifyDomain(repo, 'example.com', signer().pubkey)

  const response = await request(app, admin, 'GET', '/admin/domains')

  expect(response.body).not.toContain(stored.dkimPrivateKey)
  expect(response.body).not.toContain(stored.bridgePrivateKey)

  await app.close()
})

test('a key that is not an admin gets 403', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await verifyDomain(repo, 'example.com', alice.pubkey)

  const response = await request(app, alice, 'GET', '/admin/domains')

  expect(response.statusCode).toBe(403)
  expect(response.json()).toEqual({ error: 'not_admin' })

  await app.close()
})

test('without ADMIN_PUBKEYS nobody is an admin', async () => {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))

  const response = await request(app, signer(), 'GET', '/admin/domains')

  expect(response.statusCode).toBe(403)

  await app.close()
})

test('an unsigned request gets 401', async () => {
  const { app } = setup()

  const response = await app.inject({ method: 'GET', url: '/admin/domains' })

  expect(response.statusCode).toBe(401)
  expect(response.json()).toEqual({ error: 'missing_auth' })

  await app.close()
})

test('an admin suspends a domain, which is then no longer served', async () => {
  const { repo, app, admin } = setup()
  await verifyDomain(repo, 'example.com', signer().pubkey)

  const created = await request(app, admin, 'PUT', '/admin/domains/Example.com/suspension')
  const again = await request(app, admin, 'PUT', '/admin/domains/example.com/suspension')
  const overview = await request(app, admin, 'GET', '/admin/domains')

  expect(created.statusCode).toBe(201)
  expect(created.json()).toEqual({ suspension: { domain: 'example.com', suspendedAt: expect.any(String) } })
  expect(again.statusCode).toBe(200)
  expect(again.json()).toEqual(created.json())
  expect(overview.json().suspensions).toEqual([created.json().suspension])
  expect(overview.json().domains.map((domain: { domain: string }) => domain.domain)).toEqual(['example.com'])
  expect(await repo.findVerifiedDomain('example.com')).toBeNull()

  await app.close()
})

test('a domain nobody claims can be suspended ahead', async () => {
  const { repo, app, admin } = setup()

  const response = await request(app, admin, 'PUT', '/admin/domains/spam.example/suspension')

  expect(response.statusCode).toBe(201)
  expect(await repo.findSuspension('spam.example')).not.toBeNull()

  await app.close()
})

test('lifting the suspension serves the domain again', async () => {
  const { repo, app, admin } = setup()
  await verifyDomain(repo, 'example.com', signer().pubkey)
  await repo.suspendDomain('example.com')

  const lifted = await request(app, admin, 'DELETE', '/admin/domains/example.com/suspension')
  const again = await request(app, admin, 'DELETE', '/admin/domains/example.com/suspension')

  expect(lifted.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect(again.json()).toEqual({ error: 'suspension_not_found' })
  expect(await repo.findVerifiedDomain('example.com')).not.toBeNull()

  await app.close()
})

test('only an admin suspends or lifts a suspension', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await repo.suspendDomain('other.example')

  const suspend = await request(app, alice, 'PUT', '/admin/domains/example.com/suspension')
  const lift = await request(app, alice, 'DELETE', '/admin/domains/other.example/suspension')

  expect([suspend.statusCode, lift.statusCode]).toEqual([403, 403])
  expect(await repo.findSuspension('example.com')).toBeNull()
  expect(await repo.findSuspension('other.example')).not.toBeNull()

  await app.close()
})

test('suspending an invalid domain answers 400', async () => {
  const { app, admin } = setup()

  const response = await request(app, admin, 'PUT', '/admin/domains/localhost/suspension')

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_domain' })

  await app.close()
})

test('an admin allows a key, by npub or hex, then takes it back', async () => {
  const { repo, app, admin } = setup()
  const alice = signer()

  const created = await request(app, admin, 'PUT', `/admin/allowed-keys/${npubEncode(alice.pubkey)}`)
  const again = await request(app, admin, 'PUT', `/admin/allowed-keys/${alice.pubkey}`)
  const overview = await request(app, admin, 'GET', '/admin/domains')

  expect(created.statusCode).toBe(201)
  expect(created.json()).toEqual({ allowedKey: { pubkey: alice.pubkey, allowedAt: expect.any(String) } })
  expect(again.statusCode).toBe(200)
  expect(again.json()).toEqual(created.json())
  expect(overview.json().allowedKeys).toEqual([created.json().allowedKey])

  const removed = await request(app, admin, 'DELETE', `/admin/allowed-keys/${npubEncode(alice.pubkey)}`)
  const removedAgain = await request(app, admin, 'DELETE', `/admin/allowed-keys/${alice.pubkey}`)

  expect(removed.statusCode).toBe(204)
  expect(removedAgain.statusCode).toBe(404)
  expect(removedAgain.json()).toEqual({ error: 'allowed_key_not_found' })
  expect(await repo.isAllowedKey(alice.pubkey)).toBe(false)

  await app.close()
})

test('allowing something that is not a key answers 400', async () => {
  const { app, admin } = setup()

  const response = await request(app, admin, 'PUT', '/admin/allowed-keys/alice@example.com')

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_pubkey' })

  await app.close()
})

test('only an admin manages the allowed keys', async () => {
  const { repo, app } = setup()
  const alice = signer()
  const bob = signer()
  await repo.allowKey(bob.pubkey)

  const allow = await request(app, alice, 'PUT', `/admin/allowed-keys/${alice.pubkey}`)
  const remove = await request(app, alice, 'DELETE', `/admin/allowed-keys/${bob.pubkey}`)

  expect([allow.statusCode, remove.statusCode]).toEqual([403, 403])
  expect(await repo.isAllowedKey(alice.pubkey)).toBe(false)
  expect(await repo.isAllowedKey(bob.pubkey)).toBe(true)

  await app.close()
})

test('an admin changes some settings, the others keep their value', async () => {
  const { app, admin } = setup()

  const changed = await request(app, admin, 'PATCH', '/admin/settings', {
    openRegistration: true,
    maxMessageBytes: 10 * 1024 * 1024,
    blossomServers: ['https://Cdn.Example.com/blossom/'],
  })
  const overview = await request(app, admin, 'GET', '/admin/domains')

  expect(changed.statusCode).toBe(200)
  expect(changed.json()).toEqual({
    settings: {
      ...testSettings,
      openRegistration: true,
      maxMessageBytes: 10 * 1024 * 1024,
      blossomServers: ['https://cdn.example.com/blossom'],
    },
  })
  expect(overview.json().settings).toEqual(changed.json().settings)

  await app.close()
})

test('new indexers make every verified domain key publish its lists on them', async () => {
  const { repo, app, admin, network } = setup()
  const verified = await verifyDomain(repo, 'example.com', signer().pubkey)
  await repo.createDomain(claim('pending.example', signer().pubkey))

  await request(app, admin, 'PATCH', '/admin/settings', { maxMessageBytes: 2 * 1024 * 1024 })
  expect(network.published).toEqual([])

  await request(app, admin, 'PATCH', '/admin/settings', { indexerRelays: ['wss://new.example.org'] })
  await vi.waitFor(() => expect(network.published).toHaveLength(3))

  expect(network.published.map(({ event }) => event.pubkey)).toEqual(Array(3).fill(verified.bridgePubkey))
  expect(network.published[0].relays).toEqual(['wss://new.example.org/'])
  expect(network.published[1].event.tags).toEqual([['relay', apiConfig.relayUrl]])

  await app.close()
})

test('an invalid setting answers 400 and changes nothing', async () => {
  const { repo, app, admin } = setup()

  const response = await request(app, admin, 'PATCH', '/admin/settings', {
    openRegistration: true,
    indexerRelays: ['https://relay.example.com'],
  })

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_indexer_relays' })
  expect(repo.storedSettings.openRegistration).toBe(false)

  await app.close()
})

test('only an admin changes the settings', async () => {
  const { repo, app } = setup()

  const response = await request(app, signer(), 'PATCH', '/admin/settings', { openRegistration: true })

  expect(response.statusCode).toBe(403)
  expect(repo.storedSettings.openRegistration).toBe(false)

  await app.close()
})
