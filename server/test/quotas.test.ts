import { npubEncode } from 'nostr-tools/nip19'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { ipSubject, NO_QUOTAS } from '../src/quotas.js'
import type { Quotas } from '../src/types.js'
import {
  API_HOST,
  type App,
  apiConfig,
  authorization,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  request,
  type Signer,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

async function setup(quotas: Partial<Quotas> = {}) {
  const repo = new MemoryDomainRepository()
  const admin = signer()
  const settings = settingsStore(repo, { openRegistration: true, quotas: { ...NO_QUOTAS, ...quotas } })
  const config = { ...apiConfig, adminPubkeys: [admin.pubkey] }
  const app = buildApp(repo, config, new FakeDns(), new FakeRelayNetwork(), settings)
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  return { repo, app, admin, owner }
}

function putOwned(app: App, owner: Signer, localPart: string) {
  return request(app, owner, 'PUT', `/domains/example.com/addresses/${localPart}`, { pubkeys: [owner.pubkey] })
}

test('a key creates no address past its quota, and frees one by deleting an address', async () => {
  const { app, owner } = await setup({ addresses: 2 })

  const first = await putOwned(app, owner, 'a')
  await putOwned(app, owner, 'b')
  const over = await putOwned(app, owner, 'c')
  const changed = await request(app, owner, 'PUT', '/domains/example.com/addresses/a', {
    pubkeys: [owner.pubkey],
    private: true,
  })
  await request(app, owner, 'DELETE', '/domains/example.com/addresses/a')
  const freed = await putOwned(app, owner, 'c')

  expect(first.statusCode).toBe(201)
  expect(over.statusCode).toBe(403)
  expect(over.json()).toEqual({ error: 'address_quota' })
  expect(changed.statusCode).toBe(200)
  expect(freed.statusCode).toBe(201)
})

test('the addresses of a key count on every domain, shared ones included', async () => {
  const { repo, app, owner } = await setup({ addresses: 2 })
  const member = signer()
  await verifyDomain(repo, 'own.example', member.pubkey)
  await repo.putAddress({
    domain: 'own.example',
    localPart: 'me',
    pubkeys: [member.pubkey],
    ownerPubkey: member.pubkey,
  })
  await repo.setShared('example.com', owner.pubkey, true)

  const first = await request(app, member, 'PUT', '/addresses/example.com/alice')
  const over = await request(app, member, 'PUT', '/addresses/example.com/zoe')
  const byOwner = await putOwned(app, owner, 'support')

  expect(first.statusCode).toBe(201)
  expect(over.statusCode).toBe(403)
  expect(over.json()).toEqual({ error: 'address_quota' })
  expect(byOwner.statusCode).toBe(201)
})

test('a key creates so many addresses an hour, deleted ones included', async () => {
  const { repo, app, owner } = await setup({ addressesPerHour: 2 })

  await putOwned(app, owner, 'a')
  await request(app, owner, 'DELETE', '/domains/example.com/addresses/a')
  await putOwned(app, owner, 'b')
  const over = await putOwned(app, owner, 'c')
  for (const usage of repo.quotaUsage) usage.usedAt = new Date(Date.now() - 3601_000)
  const later = await putOwned(app, owner, 'c')

  expect(over.statusCode).toBe(429)
  expect(over.json()).toEqual({ error: 'address_rate_quota' })
  expect(later.statusCode).toBe(201)
})

// Caddy, on the Docker network, names the client.
function putFrom(app: App, user: Signer, path: string, client: string, payload?: object, peer = '172.18.0.2') {
  return app.inject({
    method: 'PUT',
    url: path,
    remoteAddress: peer,
    headers: {
      host: API_HOST,
      authorization: authorization(user.sk, { method: 'PUT', path }),
      'x-forwarded-for': client,
    },
    payload,
  })
}

test('every key creates so many addresses an hour from one IP address, unless it has no such limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const { repo, app, owner } = await setup({ addressesPerIpPerHour: 2 })
    await repo.setShared('example.com', owner.pubkey, true)
    const [alice, bob, trusted] = [signer(), signer(), signer()]
    await repo.putKeyQuotas(trusted.pubkey, { addressesPerIpPerHour: null })

    await putFrom(app, alice, '/addresses/example.com/alice', '203.0.113.7')
    await putFrom(app, owner, '/domains/example.com/addresses/support', '203.0.113.7', { pubkeys: [owner.pubkey] })
    const over = await putFrom(app, bob, '/addresses/example.com/bob', '203.0.113.7')
    const ownerOver = await putFrom(app, owner, '/domains/example.com/addresses/sales', '203.0.113.7', {
      pubkeys: [owner.pubkey],
    })
    const elsewhere = await putFrom(app, bob, '/addresses/example.com/bob', '198.51.100.4')
    const unlimited = await putFrom(app, trusted, '/addresses/example.com/trusted', '203.0.113.7')
    vi.setSystemTime(Date.now() + 3601_000)
    const later = await putFrom(app, bob, '/addresses/example.com/bob2', '203.0.113.7')

    expect(over.statusCode).toBe(429)
    expect(over.json()).toEqual({ error: 'address_ip_quota' })
    expect(ownerOver.json()).toEqual({ error: 'address_ip_quota' })
    expect([elsewhere.statusCode, unlimited.statusCode, later.statusCode]).toEqual([201, 201, 201])
  } finally {
    vi.useRealTimers()
  }
})

test('a client reaching the server directly cannot name another IP address', async () => {
  const { repo, app, owner } = await setup({ addressesPerIpPerHour: 1 })
  await repo.setShared('example.com', owner.pubkey, true)
  const alice = signer()

  await putFrom(app, alice, '/addresses/example.com/alice', '198.51.100.1', undefined, '203.0.113.9')
  const spoofed = await putFrom(app, alice, '/addresses/example.com/alice2', '198.51.100.2', undefined, '203.0.113.9')

  expect(spoofed.json()).toEqual({ error: 'address_ip_quota' })
})

test.each([
  ['203.0.113.7', '203.0.113.7'],
  ['::ffff:203.0.113.7', '203.0.113.7'],
  ['2001:db8:a:b:1:2:3:4', '2001:db8:a:b::/64'],
  ['2001:0DB8:000a:b::99', '2001:db8:a:b::/64'],
  ['2001:db8::1', '2001:db8:0:0::/64'],
  ['::1', '0:0:0:0::/64'],
  ['64:ff9b::203.0.113.7', '64:ff9b:0:0::/64'],
  ['1::2:3:4:5:203.0.113.7', '1:0:2:3::/64'],
])('%s counts as %s', (ip, subject) => {
  expect(ipSubject(ip)).toBe(subject)
})

test('an address gets keys up to the quota, and keeps those it had past a quota lowered since', async () => {
  const { app, admin, owner } = await setup({ keysPerAddress: 2 })
  const [bob, carol] = [signer(), signer()]
  const path = '/domains/example.com/addresses/team'

  const two = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey, bob.pubkey] })
  const three = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey, bob.pubkey, carol.pubkey] })
  await request(app, admin, 'PUT', `/admin/key-quotas/${owner.pubkey}`, { quotas: { keysPerAddress: 0 } })
  const kept = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey, bob.pubkey], private: true })
  const fewer = await request(app, owner, 'PUT', path, { pubkeys: [bob.pubkey] })
  const again = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey, bob.pubkey] })

  expect([two.statusCode, three.statusCode]).toEqual([201, 403])
  expect(three.json()).toEqual({ error: 'keys_per_address_quota' })
  expect([kept.statusCode, fewer.statusCode, again.statusCode]).toEqual([200, 200, 403])
})

test('a key claims no domain past its quota of domains waiting for verification', async () => {
  const { app, owner } = await setup({ pendingDomains: 1 })
  const alice = signer()

  const first = await request(app, alice, 'PUT', '/domains/one.example')
  const again = await request(app, alice, 'PUT', '/domains/one.example')
  const over = await request(app, alice, 'PUT', '/domains/two.example')
  await request(app, alice, 'DELETE', '/domains/one.example')
  const freed = await request(app, alice, 'PUT', '/domains/two.example')
  const verifiedOwner = await request(app, owner, 'PUT', '/domains/new.example')

  expect(first.statusCode).toBe(201)
  expect(again.statusCode).toBe(200)
  expect(over.statusCode).toBe(403)
  expect(over.json()).toEqual({ error: 'pending_domain_quota' })
  expect(freed.statusCode).toBe(201)
  expect(verifiedOwner.statusCode).toBe(201)
})

test("a key with quotas of its own takes them instead of the server's, and the admins have none", async () => {
  const { repo, app, admin, owner } = await setup({ addresses: 0, pendingDomains: 0 })
  await repo.putKeyQuotas(owner.pubkey, { addresses: null })

  const unlimited = await putOwned(app, owner, 'a')
  const pending = await request(app, owner, 'PUT', '/domains/new.example')
  const byAdmin = await request(app, admin, 'PUT', '/domains/admin.example')

  expect(unlimited.statusCode).toBe(201)
  expect(pending.json()).toEqual({ error: 'pending_domain_quota' })
  expect(byAdmin.statusCode).toBe(201)
})

test('GET /domains gives the quotas of the key and the addresses it holds', async () => {
  const { repo, app, admin, owner } = await setup({ addresses: 10, recipientsPerDay: 200 })
  await repo.putKeyQuotas(owner.pubkey, { addresses: 50 })
  await putOwned(app, owner, 'a')

  const own = await request(app, owner, 'GET', '/domains')
  const ofAdmin = await request(app, admin, 'GET', '/domains')

  expect(own.json().quotas).toEqual({ ...NO_QUOTAS, addresses: 50, recipientsPerDay: 200 })
  expect(own.json().usage).toEqual({ addresses: 1 })
  expect(ofAdmin.json().quotas).toEqual(NO_QUOTAS)
})

test('an admin gives a key quotas of its own, replaces them and takes them back', async () => {
  const { app, admin, owner } = await setup()
  const npub = npubEncode(owner.pubkey)

  const created = await request(app, admin, 'PUT', `/admin/key-quotas/${npub}`, {
    quotas: { addresses: 100, recipientsPerDay: null },
  })
  const replaced = await request(app, admin, 'PUT', `/admin/key-quotas/${owner.pubkey}`, {
    quotas: { pendingDomains: 3 },
  })
  const listed = await request(app, admin, 'GET', '/admin/domains')
  const removed = await request(app, admin, 'DELETE', `/admin/key-quotas/${npub}`)
  const again = await request(app, admin, 'DELETE', `/admin/key-quotas/${npub}`)

  expect(created.statusCode).toBe(201)
  expect(created.json()).toEqual({
    keyQuotas: {
      pubkey: owner.pubkey,
      quotas: { addresses: 100, recipientsPerDay: null },
      updatedAt: expect.any(String),
    },
  })
  expect(replaced.statusCode).toBe(200)
  expect(replaced.json().keyQuotas.quotas).toEqual({ pendingDomains: 3 })
  expect(listed.json().keyQuotas).toEqual([replaced.json().keyQuotas])
  expect(removed.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect(again.json()).toEqual({ error: 'key_quotas_not_found' })
})

test.each([
  [{}],
  [{ quotas: {} }],
  [{ quotas: { addresses: -1 } }],
  [{ quotas: { addresses: 1.5 } }],
  [{ quotas: { addresses: '5' } }],
  [{ quotas: { mailboxes: 5 } }],
])('PUT /admin/key-quotas refuses %j', async (body) => {
  const { app, admin, owner } = await setup()

  const response = await request(app, admin, 'PUT', `/admin/key-quotas/${owner.pubkey}`, body)

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_quotas' })
})

test('only an admin sets the quotas of a valid key', async () => {
  const { app, admin, owner } = await setup()

  const invalid = await request(app, admin, 'PUT', '/admin/key-quotas/npub1nope', { quotas: { addresses: 1 } })
  const notAdmin = await request(app, owner, 'PUT', `/admin/key-quotas/${owner.pubkey}`, { quotas: { addresses: 1 } })

  expect(invalid.json()).toEqual({ error: 'invalid_pubkey' })
  expect(notAdmin.statusCode).toBe(403)
})

test('an admin changes some quotas of the server, and the others keep their value', async () => {
  const { app, admin } = await setup({ addresses: 10 })

  const raised = await request(app, admin, 'PATCH', '/admin/settings', { quotas: { recipientsPerDay: 500 } })
  const lifted = await request(app, admin, 'PATCH', '/admin/settings', { quotas: { addresses: null } })

  expect(raised.json().settings.quotas).toEqual({ ...NO_QUOTAS, addresses: 10, recipientsPerDay: 500 })
  expect(lifted.json().settings.quotas).toEqual({ ...NO_QUOTAS, recipientsPerDay: 500 })
})
