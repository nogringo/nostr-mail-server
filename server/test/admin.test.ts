import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  apiConfig,
  claim,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  request,
  signer,
  verifyDomain,
} from './helpers.js'

function setup() {
  const repo = new MemoryDomainRepository()
  const admin = signer()
  const app = buildApp(repo, { ...apiConfig, adminPubkeys: [admin.pubkey] }, new FakeDns(), new FakeRelayNetwork())
  return { repo, app, admin }
}

test('GET /admin/domains lists every claim of every key with its address count', async () => {
  const { repo, app, admin } = setup()
  const alice = signer()
  const bob = signer()
  const verified = await verifyDomain(repo, 'example.com', alice.pubkey)
  await repo.putAddress({ domain: 'example.com', localPart: 'bob', pubkey: bob.pubkey, ownerPubkey: alice.pubkey })
  await repo.putAddress({ domain: 'example.com', localPart: 'zoe', pubkey: bob.pubkey, ownerPubkey: alice.pubkey })
  await repo.createDomain(claim('pending.example', bob.pubkey))

  const response = await request(app, admin, 'GET', '/admin/domains')

  expect(response.statusCode).toBe(200)
  expect(response.json().suspensions).toEqual([])
  expect(response.json().domains).toEqual([
    {
      domain: 'example.com',
      pubkey: alice.pubkey,
      verifiedAt: verified.verifiedAt,
      checkedAt: verified.checkedAt,
      createdAt: verified.createdAt,
      addressCount: 2,
      checks: verified.checks,
    },
    {
      domain: 'pending.example',
      pubkey: bob.pubkey,
      verifiedAt: null,
      checkedAt: null,
      createdAt: expect.any(String),
      addressCount: 0,
      checks: null,
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
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork())

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
