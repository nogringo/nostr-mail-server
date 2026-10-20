import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from '../src/app.js'
import {
  API_HOST,
  authorization,
  domainConfig,
  FakeDns,
  MemoryDomainRepository,
  type Signer,
  signer,
} from './helpers.js'

function setup() {
  const repo = new MemoryDomainRepository()
  const dns = new FakeDns()
  const app = buildApp(repo, domainConfig, dns)
  return { repo, dns, app }
}

type App = ReturnType<typeof buildApp>

function request(app: App, user: Signer, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string) {
  return app.inject({
    method,
    url: path,
    headers: { host: API_HOST, authorization: authorization(user.sk, { method, path }) },
  })
}

function publishOwnership(dns: FakeDns, domain: string, value: string) {
  dns.txtRecords.set(`_nostr-mail.${domain}`, [...(dns.txtRecords.get(`_nostr-mail.${domain}`) ?? []), value])
}

function ownershipValue(body: { domain: { records: { id: string; value: string }[] } }): string {
  const record = body.domain.records.find((record) => record.id === 'ownership')
  assert.ok(record)
  return record.value
}

test('PUT claims a domain and returns the records to publish', async () => {
  const { repo, app } = setup()
  const alice = signer()

  const response = await request(app, alice, 'PUT', '/domains/Example.com')

  assert.equal(response.statusCode, 201)
  const { domain } = response.json()
  assert.equal(domain.domain, 'example.com')
  assert.equal(domain.verifiedAt, null)
  assert.deepEqual(
    domain.records.map((record: { id: string }) => record.id),
    ['ownership', 'mx', 'spf', 'dkim', 'dmarc'],
  )
  assert.match(ownershipValue(response.json()), /^nostr-mail-verification=[0-9a-f]{32}$/)
  assert.ok(domain.records.every((record: { check: unknown }) => record.check === null))

  const stored = await repo.findDomain('example.com', alice.pubkey)
  assert.ok(stored)
  assert.ok(domain.records.find((record: { id: string }) => record.id === 'dkim').value.endsWith(stored.dkimPublicKey))

  await app.close()
})

test('the private DKIM key is never returned', async () => {
  const { repo, app } = setup()
  const alice = signer()

  const created = await request(app, alice, 'PUT', '/domains/example.com')
  const listed = await request(app, alice, 'GET', '/domains')
  const stored = await repo.findDomain('example.com', alice.pubkey)

  assert.ok(stored)
  assert.ok(stored.dkimPrivateKey.startsWith('-----BEGIN PRIVATE KEY-----'))
  for (const response of [created, listed]) {
    assert.ok(!response.body.includes('PRIVATE KEY'))
    assert.ok(!response.body.includes(stored.dkimPrivateKey.split('\n')[1]))
  }

  await app.close()
})

test('PUT again by the same key returns the same claim with 200', async () => {
  const { app } = setup()
  const alice = signer()

  const first = await request(app, alice, 'PUT', '/domains/example.com')
  const second = await request(app, alice, 'PUT', '/domains/example.com')

  assert.equal(second.statusCode, 200)
  assert.equal(ownershipValue(second.json()), ownershipValue(first.json()))

  await app.close()
})

test('PUT rejects an invalid domain', async () => {
  const { app } = setup()

  const response = await request(app, signer(), 'PUT', '/domains/localhost')

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'invalid_domain' })

  await app.close()
})

test('two keys can claim the same domain with different tokens', async () => {
  const { app } = setup()

  const alice = await request(app, signer(), 'PUT', '/domains/example.com')
  const bob = await request(app, signer(), 'PUT', '/domains/example.com')

  assert.equal(bob.statusCode, 201)
  assert.notEqual(ownershipValue(bob.json()), ownershipValue(alice.json()))

  await app.close()
})

test('GET /domains lists only the caller claims', async () => {
  const { app } = setup()
  const alice = signer()
  const bob = signer()
  await request(app, alice, 'PUT', '/domains/b.example')
  await request(app, alice, 'PUT', '/domains/a.example')
  await request(app, bob, 'PUT', '/domains/c.example')

  const response = await request(app, alice, 'GET', '/domains')

  assert.equal(response.statusCode, 200)
  assert.deepEqual(
    response.json().domains.map((domain: { domain: string }) => domain.domain),
    ['a.example', 'b.example'],
  )

  await app.close()
})

test('GET /domains/:domain hides the claims of other keys', async () => {
  const { app } = setup()
  await request(app, signer(), 'PUT', '/domains/example.com')

  const response = await request(app, signer(), 'GET', '/domains/example.com')

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { error: 'domain_not_found' })

  await app.close()
})

test('check verifies the domain once the ownership record is published', async () => {
  const { dns, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')

  const before = await request(app, alice, 'POST', '/domains/example.com/check')
  assert.equal(before.statusCode, 200)
  assert.equal(before.json().domain.verifiedAt, null)
  assert.ok(before.json().domain.checkedAt)
  assert.deepEqual(before.json().domain.records[0].check, { status: 'missing', found: [] })

  publishOwnership(dns, 'example.com', ownershipValue(created.json()))
  const after = await request(app, alice, 'POST', '/domains/example.com/check')

  assert.equal(after.statusCode, 200)
  assert.ok(after.json().domain.verifiedAt)
  assert.equal(after.json().domain.records[0].check.status, 'ok')
  assert.equal(after.json().domain.records[1].check.status, 'missing')

  await app.close()
})

test('verification sticks when a later check fails to find the record', async () => {
  const { dns, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')
  publishOwnership(dns, 'example.com', ownershipValue(created.json()))
  const verified = await request(app, alice, 'POST', '/domains/example.com/check')

  dns.txtRecords.clear()
  const later = await request(app, alice, 'POST', '/domains/example.com/check')

  assert.equal(later.json().domain.verifiedAt, verified.json().domain.verifiedAt)
  assert.equal(later.json().domain.records[0].check.status, 'missing')

  await app.close()
})

test('the key that verifies a domain drops the other claims on it', async () => {
  const { repo, dns, app } = setup()
  const alice = signer()
  const bob = signer()
  const aliceClaim = await request(app, alice, 'PUT', '/domains/example.com')
  await request(app, bob, 'PUT', '/domains/example.com')

  publishOwnership(dns, 'example.com', ownershipValue(aliceClaim.json()))
  await request(app, alice, 'POST', '/domains/example.com/check')

  assert.equal(await repo.findDomain('example.com', bob.pubkey), null)
  assert.equal((await request(app, bob, 'GET', '/domains/example.com')).statusCode, 404)

  await app.close()
})

test('a new key that proves control of the DNS takes the domain over', async () => {
  const { repo, dns, app } = setup()
  const alice = signer()
  const bob = signer()
  const aliceClaim = await request(app, alice, 'PUT', '/domains/example.com')
  publishOwnership(dns, 'example.com', ownershipValue(aliceClaim.json()))
  await request(app, alice, 'POST', '/domains/example.com/check')

  const bobClaim = await request(app, bob, 'PUT', '/domains/example.com')
  assert.equal(bobClaim.statusCode, 201)
  dns.txtRecords.set('_nostr-mail.example.com', [ownershipValue(bobClaim.json())])
  const taken = await request(app, bob, 'POST', '/domains/example.com/check')

  assert.ok(taken.json().domain.verifiedAt)
  assert.equal(await repo.findDomain('example.com', alice.pubkey), null)

  await app.close()
})

test('check of an unknown claim returns 404', async () => {
  const { app } = setup()

  const response = await request(app, signer(), 'POST', '/domains/example.com/check')

  assert.equal(response.statusCode, 404)

  await app.close()
})

test('DELETE releases the claim', async () => {
  const { app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')

  const deleted = await request(app, alice, 'DELETE', '/domains/example.com')
  const again = await request(app, alice, 'DELETE', '/domains/example.com')

  assert.equal(deleted.statusCode, 204)
  assert.equal(again.statusCode, 404)
  assert.equal((await request(app, alice, 'GET', '/domains/example.com')).statusCode, 404)

  await app.close()
})

test('DELETE does not touch the claim of another key', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')

  const response = await request(app, signer(), 'DELETE', '/domains/example.com')

  assert.equal(response.statusCode, 404)
  assert.ok(await repo.findDomain('example.com', alice.pubkey))

  await app.close()
})

test('requests without NIP-98 auth are refused', async () => {
  const { app } = setup()

  const response = await app.inject({ method: 'GET', url: '/domains', headers: { host: API_HOST } })

  assert.equal(response.statusCode, 401)
  assert.equal(response.headers['www-authenticate'], 'Nostr')
  assert.deepEqual(response.json(), { error: 'missing_auth' })

  await app.close()
})

test('a token signed for another request is refused', async () => {
  const { app } = setup()
  const alice = signer()

  const cases = [
    { reason: 'url_mismatch', token: authorization(alice.sk, { method: 'PUT', path: '/domains/other.com' }) },
    {
      reason: 'url_mismatch',
      token: authorization(alice.sk, { method: 'PUT', path: '/domains/example.com', host: 'evil.example' }),
    },
    { reason: 'method_mismatch', token: authorization(alice.sk, { method: 'DELETE', path: '/domains/example.com' }) },
    {
      reason: 'stale_event',
      token: authorization(alice.sk, {
        method: 'PUT',
        path: '/domains/example.com',
        createdAt: Math.floor(Date.now() / 1000) - 120,
      }),
    },
    {
      reason: 'invalid_event',
      token: authorization(alice.sk, { method: 'PUT', path: '/domains/example.com', kind: 1 }),
    },
    { reason: 'invalid_token', token: 'Nostr not-base64-json' },
  ]

  for (const { reason, token } of cases) {
    const response = await app.inject({
      method: 'PUT',
      url: '/domains/example.com',
      headers: { host: API_HOST, authorization: token },
    })
    assert.equal(response.statusCode, 401, reason)
    assert.deepEqual(response.json(), { error: reason })
  }

  await app.close()
})

test('a repository failure returns 500 without leaking the error', async () => {
  const { repo, app } = setup()
  repo.fail = true

  const response = await request(app, signer(), 'GET', '/domains')

  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: 'internal_error' })

  await app.close()
})
