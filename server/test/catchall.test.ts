import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  apiConfig,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  request,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

async function setup() {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  return { repo, app, owner }
}

test('the owner turns the catch-all on and off', async () => {
  const { repo, app, owner } = await setup()

  const on = await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: true })
  expect(on.statusCode).toBe(200)
  expect(on.json().domain.catchAll).toBe(true)
  expect((await repo.findVerifiedDomain('example.com'))?.catchAll).toBe(true)

  const off = await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: false })
  expect(off.json().domain.catchAll).toBe(false)

  await app.close()
})

test('only the key of an unsuspended claim sets the catch-all, with a boolean', async () => {
  const { repo, app, owner } = await setup()

  const invalid = await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: 'yes' })
  const other = await request(app, signer(), 'PUT', '/domains/example.com/catch-all', { catchAll: true })
  await repo.suspendDomain('example.com')
  const suspended = await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: true })

  expect(invalid.statusCode).toBe(400)
  expect(invalid.json()).toEqual({ error: 'invalid_catch_all' })
  expect(other.statusCode).toBe(404)
  expect(suspended.statusCode).toBe(403)

  await app.close()
})

test('a domain is shared or catch-all, not both', async () => {
  const { app, owner } = await setup()

  await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: true })
  const catchAll = await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: true })
  await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: false })
  await request(app, owner, 'PUT', '/domains/example.com/catch-all', { catchAll: true })
  const shared = await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: true })

  expect(catchAll.statusCode).toBe(409)
  expect(catchAll.json()).toEqual({ error: 'domain_shared' })
  expect(shared.statusCode).toBe(409)
  expect(shared.json()).toEqual({ error: 'domain_catch_all' })

  await app.close()
})
