import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  apiConfig,
  claim,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

test('only a verified domain that is not suspended is allowed a certificate', async () => {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))
  await verifyDomain(repo, 'example.com', signer().pubkey)
  await repo.createDomain(claim('pending.example', signer().pubkey))
  await verifyDomain(repo, 'suspended.example', signer().pubkey)
  await repo.suspendDomain('suspended.example')
  const ask = (query: string) => app.inject({ method: 'GET', url: `/certificates/allowed${query}` })

  expect((await ask('?domain=example.com')).statusCode).toBe(200)
  expect((await ask('?domain=Example.COM')).statusCode).toBe(200)
  for (const query of [
    '?domain=pending.example',
    '?domain=suspended.example',
    '?domain=unknown.example',
    '?domain=localhost',
    '',
  ]) {
    expect((await ask(query)).statusCode, query).toBe(404)
  }

  await app.close()
})
