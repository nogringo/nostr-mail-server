import { getPublicKey } from 'nostr-tools/pure'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import { API_HOST, authorization, domainConfig, FakeDns, MemoryDomainRepository, request, signer } from './helpers.js'

function setup() {
  const repo = new MemoryDomainRepository()
  const dns = new FakeDns()
  const app = buildApp(repo, domainConfig, dns)
  return { repo, dns, app }
}

function publishOwnership(dns: FakeDns, domain: string, value: string) {
  dns.txtRecords.set(`_nostr-mail.${domain}`, [...(dns.txtRecords.get(`_nostr-mail.${domain}`) ?? []), value])
}

function ownershipValue(body: { domain: { records: { id: string; value: string }[] } }): string {
  const record = body.domain.records.find((record) => record.id === 'ownership')
  if (!record) throw new Error('The ownership record is missing')
  return record.value
}

test('PUT claims a domain and returns the records to publish', async () => {
  const { repo, app } = setup()
  const alice = signer()

  const response = await request(app, alice, 'PUT', '/domains/Example.com')

  expect(response.statusCode).toBe(201)
  const { domain } = response.json()
  expect(domain.domain).toBe('example.com')
  expect(domain.verifiedAt).toBeNull()
  expect(domain.records.map((record: { id: string }) => record.id)).toEqual(['ownership', 'mx', 'spf', 'dkim', 'dmarc'])
  expect(domain.records.map((record: { check: unknown }) => record.check)).toEqual([null, null, null, null, null])
  expect(ownershipValue(response.json())).toMatch(/^nostr-mail-verification=[0-9a-f]{32}$/)

  const stored = await repo.findDomain('example.com', alice.pubkey)
  const dkim = domain.records.find((record: { id: string }) => record.id === 'dkim')
  expect(dkim.value).toBe(`v=DKIM1; k=rsa; p=${stored?.dkimPublicKey}`)
  expect(stored?.bridgePubkey).toBe(getPublicKey(Buffer.from(stored?.bridgePrivateKey ?? '', 'hex')))

  await app.close()
})

test('the private keys are never returned', async () => {
  const { repo, app } = setup()
  const alice = signer()

  const created = await request(app, alice, 'PUT', '/domains/example.com')
  const listed = await request(app, alice, 'GET', '/domains')
  const stored = await repo.findDomain('example.com', alice.pubkey)
  const dkimPrivateKey = stored?.dkimPrivateKey ?? ''

  expect(dkimPrivateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
  expect(stored?.bridgePrivateKey).toMatch(/^[0-9a-f]{64}$/)
  for (const response of [created, listed]) {
    expect(response.body).not.toContain('PRIVATE KEY')
    expect(response.body).not.toContain(dkimPrivateKey.split('\n')[1])
    expect(response.body).not.toContain(stored?.bridgePrivateKey)
  }

  await app.close()
})

test('PUT again by the same key returns the same claim with 200', async () => {
  const { app } = setup()
  const alice = signer()

  const first = await request(app, alice, 'PUT', '/domains/example.com')
  const second = await request(app, alice, 'PUT', '/domains/example.com')

  expect(second.statusCode).toBe(200)
  expect(ownershipValue(second.json())).toBe(ownershipValue(first.json()))

  await app.close()
})

test('PUT rejects an invalid domain', async () => {
  const { app } = setup()

  const response = await request(app, signer(), 'PUT', '/domains/localhost')

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_domain' })

  await app.close()
})

test('two keys can claim the same domain with different tokens and keys', async () => {
  const { repo, app } = setup()
  const alice = signer()
  const bob = signer()

  const aliceClaim = await request(app, alice, 'PUT', '/domains/example.com')
  const bobClaim = await request(app, bob, 'PUT', '/domains/example.com')

  expect(bobClaim.statusCode).toBe(201)
  expect(ownershipValue(bobClaim.json())).not.toBe(ownershipValue(aliceClaim.json()))
  expect((await repo.findDomain('example.com', bob.pubkey))?.bridgePubkey).not.toBe(
    (await repo.findDomain('example.com', alice.pubkey))?.bridgePubkey,
  )

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

  expect(response.statusCode).toBe(200)
  expect(response.json().domains.map((domain: { domain: string }) => domain.domain)).toEqual(['a.example', 'b.example'])

  await app.close()
})

test('GET /domains/:domain hides the claims of other keys', async () => {
  const { app } = setup()
  await request(app, signer(), 'PUT', '/domains/example.com')

  const response = await request(app, signer(), 'GET', '/domains/example.com')

  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'domain_not_found' })

  await app.close()
})

test('check verifies the domain once the ownership record is published', async () => {
  const { dns, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')

  const before = await request(app, alice, 'POST', '/domains/example.com/check')
  expect(before.statusCode).toBe(200)
  expect(before.json().domain.verifiedAt).toBeNull()
  expect(before.json().domain.checkedAt).toBeTypeOf('string')
  expect(before.json().domain.records[0].check).toEqual({ status: 'missing', found: [] })

  publishOwnership(dns, 'example.com', ownershipValue(created.json()))
  const after = await request(app, alice, 'POST', '/domains/example.com/check')

  expect(after.statusCode).toBe(200)
  expect(after.json().domain.verifiedAt).toBeTypeOf('string')
  expect(after.json().domain.records[0].check.status).toBe('ok')
  expect(after.json().domain.records[1].check.status).toBe('missing')

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

  expect(later.json().domain.verifiedAt).toBe(verified.json().domain.verifiedAt)
  expect(later.json().domain.records[0].check.status).toBe('missing')

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

  expect(await repo.findDomain('example.com', bob.pubkey)).toBeNull()
  expect((await request(app, bob, 'GET', '/domains/example.com')).statusCode).toBe(404)

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
  expect(bobClaim.statusCode).toBe(201)
  dns.txtRecords.set('_nostr-mail.example.com', [ownershipValue(bobClaim.json())])
  const taken = await request(app, bob, 'POST', '/domains/example.com/check')

  expect(taken.json().domain.verifiedAt).toBeTypeOf('string')
  expect(await repo.findDomain('example.com', alice.pubkey)).toBeNull()

  await app.close()
})

test('check of an unknown claim returns 404', async () => {
  const { app } = setup()

  const response = await request(app, signer(), 'POST', '/domains/example.com/check')

  expect(response.statusCode).toBe(404)

  await app.close()
})

test('DELETE releases the claim', async () => {
  const { app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')

  const deleted = await request(app, alice, 'DELETE', '/domains/example.com')
  const again = await request(app, alice, 'DELETE', '/domains/example.com')

  expect(deleted.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect((await request(app, alice, 'GET', '/domains/example.com')).statusCode).toBe(404)

  await app.close()
})

test('DELETE does not touch the claim of another key', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')

  const response = await request(app, signer(), 'DELETE', '/domains/example.com')

  expect(response.statusCode).toBe(404)
  expect(await repo.findDomain('example.com', alice.pubkey)).not.toBeNull()

  await app.close()
})

test('requests without NIP-98 auth are refused', async () => {
  const { app } = setup()

  const response = await app.inject({ method: 'GET', url: '/domains', headers: { host: API_HOST } })

  expect(response.statusCode).toBe(401)
  expect(response.headers['www-authenticate']).toBe('Nostr')
  expect(response.json()).toEqual({ error: 'missing_auth' })

  await app.close()
})

const alice = signer()

test.each([
  {
    name: 'signed for another path',
    reason: 'url_mismatch',
    token: () => authorization(alice.sk, { method: 'PUT', path: '/domains/other.com' }),
  },
  {
    name: 'signed for another host',
    reason: 'url_mismatch',
    token: () => authorization(alice.sk, { method: 'PUT', path: '/domains/example.com', host: 'evil.example' }),
  },
  {
    name: 'signed for another method',
    reason: 'method_mismatch',
    token: () => authorization(alice.sk, { method: 'DELETE', path: '/domains/example.com' }),
  },
  {
    name: 'too old',
    reason: 'stale_event',
    token: () =>
      authorization(alice.sk, {
        method: 'PUT',
        path: '/domains/example.com',
        createdAt: Math.floor(Date.now() / 1000) - 120,
      }),
  },
  {
    name: 'not a kind 27235 event',
    reason: 'invalid_event',
    token: () => authorization(alice.sk, { method: 'PUT', path: '/domains/example.com', kind: 1 }),
  },
  { name: 'not a base64 event', reason: 'invalid_token', token: () => 'Nostr not-base64-json' },
])('a token $name is refused with $reason', async ({ reason, token }) => {
  const { app } = setup()

  const response = await app.inject({
    method: 'PUT',
    url: '/domains/example.com',
    headers: { host: API_HOST, authorization: token() },
  })

  expect(response.statusCode).toBe(401)
  expect(response.json()).toEqual({ error: reason })

  await app.close()
})

test('a repository failure returns 500 without leaking the error', async () => {
  const { repo, app } = setup()
  repo.fail = true

  const response = await request(app, signer(), 'GET', '/domains')

  expect(response.statusCode).toBe(500)
  expect(response.json()).toEqual({ error: 'internal_error' })

  await app.close()
})
