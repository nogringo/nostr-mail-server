import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import { apiConfig, claim, FakeDns, FakeRelayNetwork, MemoryDomainRepository, signer, verifyDomain } from './helpers.js'

test('only a verified domain is allowed a certificate', async () => {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork())
  await verifyDomain(repo, 'example.com', signer().pubkey)
  await repo.createDomain(claim('pending.example', signer().pubkey))
  const ask = (query: string) => app.inject({ method: 'GET', url: `/certificates/allowed${query}` })

  expect((await ask('?domain=example.com')).statusCode).toBe(200)
  expect((await ask('?domain=Example.COM')).statusCode).toBe(200)
  for (const query of ['?domain=pending.example', '?domain=unknown.example', '?domain=localhost', '']) {
    expect((await ask(query)).statusCode, query).toBe(404)
  }

  await app.close()
})
