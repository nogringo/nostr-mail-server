import { npubEncode } from 'nostr-tools/nip19'
import { expect, test } from 'vitest'
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
  verifyDomain,
} from './helpers.js'

async function setup() {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))
  const owner = signer()
  const domain = await verifyDomain(repo, 'example.com', owner.pubkey)
  return { repo, app, owner, domain }
}

test('PUT creates an address from an npub and stores the hex pubkey', async () => {
  const { repo, app, owner } = await setup()
  const bob = signer()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/Bob', {
    pubkeys: [npubEncode(bob.pubkey)],
  })

  expect(response.statusCode).toBe(201)
  expect(response.json()).toEqual({
    address: {
      domain: 'example.com',
      localPart: 'bob',
      address: 'bob@example.com',
      pubkeys: [bob.pubkey],
      createdBy: owner.pubkey,
      private: false,
      enabled: true,
      createdAt: expect.any(String),
    },
  })
  expect((await repo.findAddress('example.com', 'bob'))?.ownerPubkey).toBe(owner.pubkey)

  await app.close()
})

test('PUT gives an address several pubkeys, each once, in the order given', async () => {
  const { repo, app, owner } = await setup()
  const bob = signer()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/team', {
    pubkeys: [npubEncode(bob.pubkey), owner.pubkey, bob.pubkey],
  })

  expect(response.statusCode).toBe(201)
  expect(response.json().address.pubkeys).toEqual([bob.pubkey, owner.pubkey])
  expect((await repo.findAddress('example.com', 'team'))?.pubkeys).toEqual([bob.pubkey, owner.pubkey])

  await app.close()
})

test('PUT makes an address private, then public again when private is left out', async () => {
  const { repo, app, owner } = await setup()
  const path = '/domains/example.com/addresses/shop'

  const hidden = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey], private: true })
  expect(hidden.statusCode).toBe(201)
  expect(hidden.json().address.private).toBe(true)
  expect((await repo.findAddress('example.com', 'shop'))?.private).toBe(true)

  const shown = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey] })
  expect(shown.statusCode).toBe(200)
  expect(shown.json().address.private).toBe(false)

  await app.close()
})

test.each(['yes', 1, {}])('PUT refuses private %j with invalid_private', async (value) => {
  const { repo, app, owner } = await setup()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/shop', {
    pubkeys: [owner.pubkey],
    private: value,
  })

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_private' })
  expect(await repo.findAddress('example.com', 'shop')).toBeNull()

  await app.close()
})

test('PUT disables an address, then enables it again when enabled is left out', async () => {
  const { repo, app, owner } = await setup()
  const path = '/domains/example.com/addresses/shop'

  const disabled = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey], private: true, enabled: false })
  expect(disabled.statusCode).toBe(201)
  expect(disabled.json().address).toMatchObject({ private: true, enabled: false })
  expect((await repo.findAddress('example.com', 'shop'))?.enabled).toBe(false)

  const enabled = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey], private: true })
  expect(enabled.statusCode).toBe(200)
  expect(enabled.json().address).toMatchObject({ private: true, enabled: true })

  await app.close()
})

test.each(['no', 0, {}])('PUT refuses enabled %j with invalid_enabled', async (value) => {
  const { repo, app, owner } = await setup()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/shop', {
    pubkeys: [owner.pubkey],
    enabled: value,
  })

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_enabled' })
  expect(await repo.findAddress('example.com', 'shop')).toBeNull()

  await app.close()
})

test('PUT on an existing address points it at the new pubkey with 200', async () => {
  const { app, owner } = await setup()
  const first = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [signer().pubkey] })

  const carol = signer()
  const second = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [carol.pubkey] })

  expect(second.statusCode).toBe(200)
  expect(second.json().address.pubkeys).toEqual([carol.pubkey])
  expect(second.json().address.createdAt).toBe(first.json().address.createdAt)

  await app.close()
})

test('GET lists the addresses of the domain', async () => {
  const { app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/zoe', { pubkeys: [signer().pubkey] })
  await request(app, owner, 'PUT', '/domains/example.com/addresses/alice', { pubkeys: [owner.pubkey] })

  const response = await request(app, owner, 'GET', '/domains/example.com/addresses')

  expect(response.statusCode).toBe(200)
  expect(response.json().addresses.map((address: { address: string }) => address.address)).toEqual([
    'alice@example.com',
    'zoe@example.com',
  ])

  await app.close()
})

test('DELETE removes the address', async () => {
  const { app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [signer().pubkey] })

  const deleted = await request(app, owner, 'DELETE', '/domains/example.com/addresses/bob')
  const again = await request(app, owner, 'DELETE', '/domains/example.com/addresses/bob')

  expect(deleted.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect(again.json()).toEqual({ error: 'address_not_found' })

  await app.close()
})

test('a deleted address is listed and nothing creates it again until the owner allows it', async () => {
  const { app, owner } = await setup()
  const path = '/domains/example.com/addresses/bob'
  await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey] })
  await request(app, owner, 'DELETE', path)

  const listed = await request(app, owner, 'GET', '/domains/example.com/addresses')
  const refused = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey] })
  const allowed = await request(app, owner, 'DELETE', '/domains/example.com/deleted-addresses/bob')
  const again = await request(app, owner, 'DELETE', '/domains/example.com/deleted-addresses/bob')
  const created = await request(app, owner, 'PUT', path, { pubkeys: [owner.pubkey] })

  expect(listed.json()).toEqual({
    addresses: [],
    deletedAddresses: [
      { domain: 'example.com', localPart: 'bob', address: 'bob@example.com', deletedAt: expect.any(String) },
    ],
  })
  expect(refused.statusCode).toBe(409)
  expect(refused.json()).toEqual({ error: 'address_deleted' })
  expect(allowed.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect(again.json()).toEqual({ error: 'deleted_address_not_found' })
  expect(created.statusCode).toBe(201)

  await app.close()
})

test('the owner allows every deleted address at once', async () => {
  const { repo, app, owner } = await setup()
  for (const localPart of ['alice', 'bob']) {
    await request(app, owner, 'PUT', `/domains/example.com/addresses/${localPart}`, { pubkeys: [owner.pubkey] })
    await request(app, owner, 'DELETE', `/domains/example.com/addresses/${localPart}`)
  }

  const response = await request(app, owner, 'DELETE', '/domains/example.com/deleted-addresses')

  expect(response.statusCode).toBe(204)
  expect(await repo.listDeletedAddresses('example.com')).toEqual([])

  await app.close()
})

test('the owner manages an address the catch-all created, whatever its local part', async () => {
  const { repo, app, owner, domain } = await setup()
  for (const localPart of ['bob+news', 'a/b#c']) await repo.createCatchAllAddress(domain, localPart)

  const shown = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob%2Bnews', {
    pubkeys: [owner.pubkey],
  })
  const deleted = await request(app, owner, 'DELETE', '/domains/example.com/addresses/a%2Fb%23c')
  const allowed = await request(app, owner, 'DELETE', '/domains/example.com/deleted-addresses/a%2Fb%23c')

  expect(shown.statusCode).toBe(200)
  expect(shown.json().address).toMatchObject({ address: 'bob+news@example.com', private: false })
  expect([deleted.statusCode, allowed.statusCode]).toEqual([204, 204])

  await app.close()
})

test('only the verified owner manages addresses', async () => {
  const { repo, app } = await setup()
  const claimant = signer()
  await repo.createDomain(claim('pending.example', claimant.pubkey))

  const stranger = await request(app, signer(), 'GET', '/domains/example.com/addresses')
  const unverified = await request(app, claimant, 'PUT', '/domains/pending.example/addresses/bob', {
    pubkeys: [claimant.pubkey],
  })

  expect(stranger.statusCode).toBe(404)
  expect(stranger.json()).toEqual({ error: 'domain_not_found' })
  expect(unverified.statusCode).toBe(409)
  expect(unverified.json()).toEqual({ error: 'domain_not_verified' })

  await app.close()
})

test('the addresses of a suspended domain cannot be managed', async () => {
  const { repo, app, owner } = await setup()
  await repo.suspendDomain('example.com')

  const listed = await request(app, owner, 'GET', '/domains/example.com/addresses')
  const added = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [owner.pubkey] })

  expect([listed.statusCode, added.statusCode]).toEqual([403, 403])
  expect(added.json()).toEqual({ error: 'domain_suspended' })
  expect(await repo.findAddress('example.com', 'bob')).toBeNull()

  await app.close()
})

test.each([
  { localPart: 'a..b', error: 'invalid_local_part' },
  { localPart: 'alice+tag', error: 'invalid_local_part' },
  { localPart: '_smtp', error: 'reserved_local_part' },
  { localPart: npubEncode('a'.repeat(64)), error: 'reserved_local_part' },
  { localPart: 'npub1typo', error: 'reserved_local_part' },
])('PUT refuses $localPart with $error', async ({ localPart, error }) => {
  const { app, owner } = await setup()

  const response = await request(app, owner, 'PUT', `/domains/example.com/addresses/${localPart}`, {
    pubkeys: [owner.pubkey],
  })

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error })

  await app.close()
})

test.each([
  { pubkeys: ['npub1typo'] },
  { pubkeys: ['abc'] },
  { pubkeys: [42] },
  { pubkeys: [] },
  { pubkeys: 'a'.repeat(64) },
  { pubkey: 'a'.repeat(64) },
  {},
])('PUT refuses the body %j with invalid_pubkeys', async (body) => {
  const { app, owner } = await setup()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', body)

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: 'invalid_pubkeys' })

  await app.close()
})

test('the addresses go away when another key takes the domain over', async () => {
  const { repo, app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [signer().pubkey] })

  await verifyDomain(repo, 'example.com', signer().pubkey)

  expect(await repo.listAddresses('example.com')).toEqual([])

  await app.close()
})

test('the addresses go away when the owner releases the domain', async () => {
  const { repo, app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkeys: [signer().pubkey] })

  await request(app, owner, 'DELETE', '/domains/example.com')

  expect(await repo.listAddresses('example.com')).toEqual([])

  await app.close()
})
