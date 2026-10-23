import { npubEncode, nsecEncode } from 'nostr-tools/nip19'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import { DomainSigners } from '../src/bunker.js'
import {
  API_HOST,
  apiConfig,
  authorization,
  BUNKER_RELAY,
  FakeBunker,
  FakeDns,
  FakeRelayNetwork,
  fakeNip05,
  MemoryDomainRepository,
  type Nip05Answers,
  outboundWrap,
  privateKeyOf,
  request,
  settingsStore,
  signer,
  testSettings,
  verifyDomain,
} from './helpers.js'

function setup(bunker = new FakeBunker()) {
  const repo = new MemoryDomainRepository()
  const dns = new FakeDns()
  const nip05: Nip05Answers = {}
  const network = new FakeRelayNetwork()
  const signers = new DomainSigners({ open: bunker.open, timeoutMs: 50, connectTimeoutMs: 50 })
  const app = buildApp(repo, apiConfig, dns, network, settingsStore(repo, { openRegistration: true }), {
    signers,
    nip05Lookup: fakeNip05(nip05),
  })
  return { repo, dns, nip05, network, app }
}

function publishOwnership(dns: FakeDns, domain: string, value: string) {
  dns.txtRecords.set(`_nostr-mail.${domain}`, [...(dns.txtRecords.get(`_nostr-mail.${domain}`) ?? []), value])
}

function recordOf(body: { domain: { records: { id: string }[] } }, id: string) {
  return body.domain.records.find((record) => record.id === id)
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
  expect(domain.blossomServers).toEqual(testSettings.blossomServers)
  expect(domain.records.map((record: { id: string }) => record.id)).toEqual([
    'ownership',
    'mx',
    'nip05',
    'spf',
    'dkim',
    'dmarc',
  ])
  expect(domain.records.map((record: { check: unknown }) => record.check)).toEqual([null, null, null, null, null, null])
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
  expect(response.json().canClaim).toBe(true)

  await app.close()
})

function closedSetup() {
  const repo = new MemoryDomainRepository()
  const admin = signer()
  const app = buildApp(
    repo,
    { ...apiConfig, adminPubkeys: [admin.pubkey] },
    new FakeDns(),
    new FakeRelayNetwork(),
    settingsStore(repo),
  )
  return { repo, app, admin }
}

test('while registration is closed only the admins and the allowed keys connect a domain', async () => {
  const { repo, app, admin } = closedSetup()
  const alice = signer()
  const stranger = signer()
  await repo.allowKey(alice.pubkey)

  const refused = await request(app, stranger, 'PUT', '/domains/stranger.example')
  const allowed = await request(app, alice, 'PUT', '/domains/alice.example')
  const byAdmin = await request(app, admin, 'PUT', '/domains/admin.example')

  expect(refused.statusCode).toBe(403)
  expect(refused.json()).toEqual({ error: 'not_allowed' })
  expect(await repo.findDomain('stranger.example', stranger.pubkey)).toBeNull()
  expect([allowed.statusCode, byAdmin.statusCode]).toEqual([201, 201])

  await app.close()
})

test('GET /domains tells whether the key can connect a domain', async () => {
  const { repo, app, admin } = closedSetup()
  const alice = signer()
  await repo.allowKey(alice.pubkey)

  const answers = await Promise.all(
    [signer(), alice, admin].map(async (user) => (await request(app, user, 'GET', '/domains')).json().canClaim),
  )

  expect(answers).toEqual([false, true, true])

  await app.close()
})

test('a key no longer allowed keeps its claims but makes no new one', async () => {
  const { repo, app } = closedSetup()
  const alice = signer()
  await repo.allowKey(alice.pubkey)
  await request(app, alice, 'PUT', '/domains/alice.example')
  await repo.disallowKey(alice.pubkey)

  const again = await request(app, alice, 'PUT', '/domains/alice.example')
  const other = await request(app, alice, 'PUT', '/domains/other.example')
  const listed = await request(app, alice, 'GET', '/domains')

  expect(again.statusCode).toBe(200)
  expect(other.statusCode).toBe(403)
  expect(listed.json().domains.map((domain: { domain: string }) => domain.domain)).toEqual(['alice.example'])

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

test('a check that finds the domain verified publishes the lists of its key', async () => {
  const { repo, dns, network, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')
  await request(app, alice, 'POST', '/domains/example.com/check')
  expect(network.published).toHaveLength(0)

  publishOwnership(dns, 'example.com', ownershipValue(created.json()))
  await request(app, alice, 'POST', '/domains/example.com/check')

  const claim = await repo.findDomain('example.com', alice.pubkey)
  expect(network.published.map(({ event }) => event.kind)).toEqual([10002, 10050, 10063])
  for (const { relays, event, auth } of network.published) {
    expect(relays).toEqual(['wss://relay.example.org/', 'wss://indexer.example.org/'])
    expect(event.pubkey).toBe(claim?.bridgePubkey)
    expect(verifyEvent(event)).toBe(true)
    expect(auth.pubkey).toBe(claim?.bridgePubkey)
  }
  expect(network.published[0].event.tags).toEqual([['r', 'wss://relay.example.org/']])
  expect(network.published[1].event.tags).toEqual([['relay', 'wss://relay.example.org/']])
  expect(network.published[2].event.tags).toEqual([['server', 'https://blossom.example.org']])
})

test('a check still succeeds when the lists cannot be published', async () => {
  const { dns, network, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')
  network.down.add('wss://relay.example.org/').add('wss://indexer.example.org/')

  publishOwnership(dns, 'example.com', ownershipValue(created.json()))
  const response = await request(app, alice, 'POST', '/domains/example.com/check')

  expect(response.statusCode).toBe(200)
  expect(response.json().domain.verifiedAt).toBeTypeOf('string')
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

test('the owner serves NIP-05 from their own website, then _smtp is checked instead of the A record', async () => {
  const { repo, dns, nip05, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')
  const bridgePubkey = (await repo.findDomain('example.com', alice.pubkey))?.bridgePubkey ?? ''
  dns.addressRecords.set('example.com', [apiConfig.publicIpv4])
  nip05['_smtp@example.com'] = { pubkey: bridgePubkey }

  const owner = await request(app, alice, 'PUT', '/domains/example.com/nip05', { nip05: 'owner' })

  expect(owner.statusCode).toBe(200)
  expect(owner.json().domain.nip05).toBe('owner')
  expect(recordOf(owner.json(), 'nip05')).toMatchObject({
    type: 'NIP-05',
    name: '_smtp@example.com',
    value: bridgePubkey,
    check: { status: 'ok', found: [bridgePubkey] },
  })

  const server = await request(app, alice, 'PUT', '/domains/example.com/nip05', { nip05: 'server' })

  expect(server.json().domain.nip05).toBe('server')
  expect(recordOf(server.json(), 'nip05')).toMatchObject({
    type: 'A',
    value: apiConfig.publicIpv4,
    check: { status: 'ok', found: [apiConfig.publicIpv4] },
  })

  await app.close()
})

test('the NIP-05 host is server or owner, set by the key of an unsuspended claim', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')

  const invalid = await request(app, alice, 'PUT', '/domains/example.com/nip05', { nip05: 'elsewhere' })
  const other = await request(app, signer(), 'PUT', '/domains/example.com/nip05', { nip05: 'owner' })
  await repo.suspendDomain('example.com')
  const suspended = await request(app, alice, 'PUT', '/domains/example.com/nip05', { nip05: 'owner' })

  expect(invalid.statusCode).toBe(400)
  expect(invalid.json()).toEqual({ error: 'invalid_nip05' })
  expect(other.statusCode).toBe(404)
  expect(suspended.statusCode).toBe(403)
  expect(await repo.findDomain('example.com', alice.pubkey)).toMatchObject({ nip05: 'server', checkedAt: null })

  await app.close()
})

test('a suspended domain shows to its owner, cannot be checked nor claimed by another key', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')
  const suspension = await repo.suspendDomain('example.com')

  const listed = await request(app, alice, 'GET', '/domains')
  const again = await request(app, alice, 'PUT', '/domains/example.com')
  const check = await request(app, alice, 'POST', '/domains/example.com/check')
  const other = await request(app, signer(), 'PUT', '/domains/example.com')

  expect(listed.json().domains[0].suspendedAt).toBe(suspension.suspendedAt)
  expect(again.statusCode).toBe(200)
  expect(again.json().domain.suspendedAt).toBe(suspension.suspendedAt)
  expect(check.statusCode).toBe(403)
  expect(check.json()).toEqual({ error: 'domain_suspended' })
  expect(other.statusCode).toBe(403)
  expect(other.json()).toEqual({ error: 'domain_suspended' })
  expect(await repo.findDomain('example.com', alice.pubkey)).toMatchObject({ checkedAt: null })

  await app.close()
})

test('the owner reads the nsec of the domain key, no other key can', async () => {
  const { repo, app } = setup()
  const alice = signer()
  const created = await request(app, alice, 'PUT', '/domains/example.com')

  const response = await request(app, alice, 'GET', '/domains/example.com/key')
  const other = await request(app, signer(), 'GET', '/domains/example.com/key')

  const stored = await repo.findDomain('example.com', alice.pubkey)
  expect(created.json().domain.bridgePubkey).toBe(stored?.bridgePubkey)
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toEqual({ nsec: nsecEncode(hexToBytes(stored?.bridgePrivateKey ?? '')) })
  expect(other.statusCode).toBe(404)

  await app.close()
})

test('the owner replaces the domain key with an nsec, whose lists are published at once', async () => {
  const { repo, network, app } = setup()
  const alice = signer()
  const verified = await verifyDomain(repo, 'example.com', alice.pubkey)
  await repo.addOutboundMessage({
    wrapId: 'queued',
    bridgePubkey: verified.bridgePubkey,
    wrap: outboundWrap(signer(), verified.bridgePubkey),
    recipients: ['bob@remote.example'],
  })
  const replacement = signer()

  const response = await request(app, alice, 'PUT', '/domains/example.com/key', { nsec: nsecEncode(replacement.sk) })

  expect(response.statusCode).toBe(200)
  expect(response.json().domain.bridgePubkey).toBe(replacement.pubkey)
  expect(await repo.findDomain('example.com', alice.pubkey)).toMatchObject({
    bridgePubkey: replacement.pubkey,
    bridgePrivateKey: bytesToHex(replacement.sk),
  })
  expect(repo.outbound.size).toBe(0)
  expect(network.published.map(({ event }) => [event.kind, event.pubkey])).toEqual([
    [10002, replacement.pubkey],
    [10050, replacement.pubkey],
    [10063, replacement.pubkey],
  ])
  const nip05 = await app.inject({
    method: 'GET',
    url: '/.well-known/nostr.json?name=_smtp',
    headers: { host: 'example.com' },
  })
  expect(nip05.json().names._smtp).toBe(replacement.pubkey)

  await app.close()
})

test('an unverified claim takes a new key without publishing its lists', async () => {
  const { repo, network, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')
  const replacement = signer()

  const response = await request(app, alice, 'PUT', '/domains/example.com/key', { nsec: nsecEncode(replacement.sk) })

  expect(response.statusCode).toBe(200)
  expect((await repo.findDomain('example.com', alice.pubkey))?.bridgePubkey).toBe(replacement.pubkey)
  expect(network.published).toEqual([])

  await app.close()
})

test('the domain key cannot become a bad nsec, the owner key or the key of another domain', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await request(app, alice, 'PUT', '/domains/example.com')
  const other = await verifyDomain(repo, 'other.example', signer().pubkey)
  const before = await repo.findDomain('example.com', alice.pubkey)
  const put = (payload?: object) => request(app, alice, 'PUT', '/domains/example.com/key', payload)

  const answers = [
    await put(),
    await put({ nsec: 'nsec1nope' }),
    await put({ nsec: npubEncode(alice.pubkey) }),
    await put({ nsec: nsecEncode(alice.sk) }),
    await put({ nsec: nsecEncode(hexToBytes(privateKeyOf(other))) }),
  ]

  expect(answers.map((answer) => [answer.statusCode, answer.json().error])).toEqual([
    [400, 'invalid_nsec'],
    [400, 'invalid_nsec'],
    [400, 'invalid_nsec'],
    [400, 'owner_key'],
    [409, 'key_in_use'],
  ])
  expect(await repo.findDomain('example.com', alice.pubkey)).toEqual(before)

  await app.close()
})

test('giving the current key again changes nothing, a suspended domain keeps its key', async () => {
  const { repo, network, app } = setup()
  const alice = signer()
  const verified = await verifyDomain(repo, 'example.com', alice.pubkey)
  await repo.addOutboundMessage({ wrapId: 'refused', bridgePubkey: verified.bridgePubkey, refusal: 'No' })
  const current = { nsec: nsecEncode(hexToBytes(privateKeyOf(verified))) }

  const same = await request(app, alice, 'PUT', '/domains/example.com/key', current)
  await repo.suspendDomain('example.com')
  const suspended = await request(app, alice, 'PUT', '/domains/example.com/key', { nsec: nsecEncode(signer().sk) })
  const read = await request(app, alice, 'GET', '/domains/example.com/key')
  const unknown = await request(app, signer(), 'PUT', '/domains/example.com/key', current)

  expect(same.statusCode).toBe(200)
  expect(same.json().domain.bridgePubkey).toBe(verified.bridgePubkey)
  expect(repo.outbound.has('refused')).toBe(true)
  expect(network.published).toEqual([])
  expect(suspended.statusCode).toBe(403)
  expect(suspended.json()).toEqual({ error: 'domain_suspended' })
  expect(read.json()).toEqual(current)
  expect(unknown.statusCode).toBe(404)
  expect(await repo.findDomain('example.com', alice.pubkey)).toEqual(verified)

  await app.close()
})

test('the owner hands the domain key to a bunker, which then signs its lists', async () => {
  const bunker = new FakeBunker()
  const { repo, network, app } = setup(bunker)
  const alice = signer()
  await verifyDomain(repo, 'example.com', alice.pubkey)

  const response = await request(app, alice, 'PUT', '/domains/example.com/key', { bunker: bunker.url })
  const read = await request(app, alice, 'GET', '/domains/example.com/key')

  expect(response.statusCode).toBe(200)
  expect(response.json().domain).toMatchObject({ bridgePubkey: bunker.key.pubkey, bridgeSigner: 'bunker' })
  const stored = await repo.findDomain('example.com', alice.pubkey)
  expect(stored).toMatchObject({
    bridgePubkey: bunker.key.pubkey,
    bridgePrivateKey: null,
    bridgeBunker: { signerPubkey: bunker.signerKey.pubkey, relays: [BUNKER_RELAY] },
  })
  expect(response.body).not.toContain(stored?.bridgeBunker?.clientKey)
  expect(bunker.methods()).toEqual([
    'connect',
    'get_public_key',
    'nip44_encrypt',
    'nip44_decrypt',
    'sign_event',
    'sign_event',
    'sign_event',
  ])
  const clientPubkey = getPublicKey(hexToBytes(stored?.bridgeBunker?.clientKey ?? ''))
  expect(bunker.requests.every((request) => request.clientPubkey === clientPubkey)).toBe(true)
  expect(network.published.map(({ event }) => [event.kind, event.pubkey])).toEqual([
    [10002, bunker.key.pubkey],
    [10050, bunker.key.pubkey],
    [10063, bunker.key.pubkey],
  ])
  expect(read.statusCode).toBe(409)
  expect(read.json()).toEqual({ error: 'key_in_bunker' })

  await app.close()
})

test.each([
  ['a URL that is not a bunker', () => {}, 'nostrconnect://x', 400, 'invalid_bunker_url'],
  [
    'a bunker that does not answer',
    (bunker: FakeBunker) => Object.assign(bunker, { silent: true }),
    '',
    504,
    'bunker_timeout',
  ],
  [
    'a bunker that refuses',
    (bunker: FakeBunker) => Object.assign(bunker, { refusing: 'no' }),
    '',
    502,
    'bunker_refused',
  ],
])('%s leaves the domain key where it was', async (_, prepare, url, status, error) => {
  const bunker = new FakeBunker()
  prepare(bunker)
  const { repo, app } = setup(bunker)
  const alice = signer()
  const before = await verifyDomain(repo, 'example.com', alice.pubkey)

  const response = await request(app, alice, 'PUT', '/domains/example.com/key', { bunker: url || bunker.url })

  expect(response.statusCode).toBe(status)
  expect(response.json()).toEqual({ error })
  expect(await repo.findDomain('example.com', alice.pubkey)).toEqual(before)

  await app.close()
})

test('a bunker holding the owner key or the key of another domain is refused', async () => {
  const alice = signer()
  const ownBunker = setup(new FakeBunker(alice))
  await verifyDomain(ownBunker.repo, 'example.com', alice.pubkey)
  const own = await request(ownBunker.app, alice, 'PUT', '/domains/example.com/key', {
    bunker: new FakeBunker(alice).url,
  })

  const taken = signer()
  const takenBunker = setup(new FakeBunker(taken))
  await verifyDomain(takenBunker.repo, 'example.com', alice.pubkey)
  const other = await verifyDomain(takenBunker.repo, 'other.example', signer().pubkey)
  await takenBunker.repo.replaceBridgeKey('other.example', other.pubkey, {
    bridgePubkey: taken.pubkey,
    bridgePrivateKey: bytesToHex(taken.sk),
    bridgeBunker: null,
  })
  const inUse = await request(takenBunker.app, alice, 'PUT', '/domains/example.com/key', {
    bunker: new FakeBunker(taken).url,
  })

  expect([own.statusCode, own.json().error]).toEqual([400, 'owner_key'])
  expect([inUse.statusCode, inUse.json().error]).toEqual([409, 'key_in_use'])

  await ownBunker.app.close()
  await takenBunker.app.close()
})

test('the domain key moves into a bunker and back with its queued mail', async () => {
  const domainKey = signer()
  const { repo, app } = setup(new FakeBunker(domainKey))
  const alice = signer()
  await verifyDomain(repo, 'example.com', alice.pubkey)
  const nsec = { nsec: nsecEncode(domainKey.sk) }
  await request(app, alice, 'PUT', '/domains/example.com/key', nsec)
  await repo.addOutboundMessage({
    wrapId: 'queued',
    bridgePubkey: domainKey.pubkey,
    wrap: outboundWrap(signer(), domainKey.pubkey),
    recipients: ['bob@remote.example'],
  })

  const moved = await request(app, alice, 'PUT', '/domains/example.com/key', {
    bunker: new FakeBunker(domainKey).url,
  })
  const inBunker = await repo.findDomain('example.com', alice.pubkey)
  const back = await request(app, alice, 'PUT', '/domains/example.com/key', nsec)

  expect(moved.json().domain).toMatchObject({ bridgePubkey: domainKey.pubkey, bridgeSigner: 'bunker' })
  expect(inBunker?.bridgePrivateKey).toBeNull()
  expect(back.json().domain).toMatchObject({ bridgePubkey: domainKey.pubkey, bridgeSigner: 'server' })
  expect(await repo.findDomain('example.com', alice.pubkey)).toMatchObject({
    bridgePrivateKey: bytesToHex(domainKey.sk),
    bridgeBunker: null,
  })
  expect(repo.outbound.has('queued')).toBe(true)

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
