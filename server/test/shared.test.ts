import { npubEncode } from 'nostr-tools/nip19'
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

async function setup({ shared = true } = {}) {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork(), settingsStore(repo))
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  await repo.setShared('example.com', owner.pubkey, shared)
  return { repo, app, owner, member: signer() }
}

test('the owner shares the domain and stops sharing it', async () => {
  const { repo, app, owner } = await setup({ shared: false })

  const shared = await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: true })
  expect(shared.statusCode).toBe(200)
  expect(shared.json().domain.shared).toBe(true)
  expect(await repo.listSharedDomains()).toEqual(['example.com'])

  const closed = await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: false })
  expect(closed.json().domain.shared).toBe(false)
  expect(await repo.listSharedDomains()).toEqual([])

  await app.close()
})

test('only the key of an unsuspended claim shares it, with a boolean', async () => {
  const { repo, app, owner, member } = await setup({ shared: false })

  const invalid = await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: 'yes' })
  const other = await request(app, member, 'PUT', '/domains/example.com/shared', { shared: true })
  await repo.suspendDomain('example.com')
  const suspended = await request(app, owner, 'PUT', '/domains/example.com/shared', { shared: true })

  expect(invalid.statusCode).toBe(400)
  expect(invalid.json()).toEqual({ error: 'invalid_shared' })
  expect(other.statusCode).toBe(404)
  expect(suspended.statusCode).toBe(403)
  expect((await repo.findDomain('example.com', owner.pubkey))?.shared).toBe(false)

  await app.close()
})

test('a key creates an address for itself on a shared domain', async () => {
  const { repo, app, owner, member } = await setup()

  const response = await request(app, member, 'PUT', '/addresses/example.com/Alice', { private: true })

  expect(response.statusCode).toBe(201)
  expect(response.json()).toEqual({
    address: {
      domain: 'example.com',
      localPart: 'alice',
      address: 'alice@example.com',
      pubkey: member.pubkey,
      createdBy: member.pubkey,
      private: true,
      createdAt: expect.any(String),
    },
  })
  expect(await repo.findAddress('example.com', 'alice')).toMatchObject({
    pubkey: member.pubkey,
    ownerPubkey: owner.pubkey,
    createdBy: member.pubkey,
  })

  await app.close()
})

test('GET /domains lists the shared domains of other keys and the addresses created there', async () => {
  const { repo, app, owner, member } = await setup()
  await verifyDomain(repo, 'own.example', member.pubkey)
  await repo.setShared('own.example', member.pubkey, true)
  await verifyDomain(repo, 'closed.example', owner.pubkey)
  await request(app, member, 'PUT', '/addresses/example.com/zoe')
  await request(app, member, 'PUT', '/addresses/example.com/alice')
  await request(app, member, 'PUT', '/addresses/own.example/me')

  const response = await request(app, member, 'GET', '/domains')

  expect(response.json().sharedDomains).toEqual(['example.com'])
  expect(response.json().addresses.map((address: { address: string }) => address.address)).toEqual([
    'alice@example.com',
    'zoe@example.com',
  ])
  expect((await request(app, owner, 'GET', '/domains')).json()).toMatchObject({
    sharedDomains: ['own.example'],
    addresses: [],
  })

  await app.close()
})

test('a key creates no address on a domain that is not shared or not in service', async () => {
  const { repo, app, owner, member } = await setup({ shared: false })
  await verifyDomain(repo, 'suspended.example', owner.pubkey)
  await repo.setShared('suspended.example', owner.pubkey, true)
  await repo.suspendDomain('suspended.example')

  for (const domain of ['example.com', 'suspended.example', 'unknown.example']) {
    const response = await request(app, member, 'PUT', `/addresses/${domain}/alice`)
    expect(response.statusCode, domain).toBe(403)
    expect(response.json()).toEqual({ error: 'domain_not_shared' })
  }
  expect(await repo.findAddress('example.com', 'alice')).toBeNull()

  await app.close()
})

test('an address of the owner or of another key is taken', async () => {
  const { app, owner, member } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: owner.pubkey })
  await request(app, signer(), 'PUT', '/addresses/example.com/carol')

  for (const localPart of ['bob', 'carol']) {
    const response = await request(app, member, 'PUT', `/addresses/example.com/${localPart}`)
    expect(response.statusCode, localPart).toBe(409)
    expect(response.json()).toEqual({ error: 'address_taken' })
  }

  await app.close()
})

test.each(['abuse', 'postmaster', 'support', 'admin', 'no-reply', '_smtp', 'npub1typo'])(
  'only the owner gives out %s',
  async (localPart) => {
    const { app, member } = await setup()

    const response = await request(app, member, 'PUT', `/addresses/example.com/${localPart}`)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'reserved_local_part' })

    await app.close()
  },
)

test('a key keeps managing its address once the domain is no longer shared, but creates no new one', async () => {
  const { repo, app, owner, member } = await setup()
  await request(app, member, 'PUT', '/addresses/example.com/alice')
  await repo.setShared('example.com', owner.pubkey, false)

  const hidden = await request(app, member, 'PUT', '/addresses/example.com/alice', { private: true })
  const created = await request(app, member, 'PUT', '/addresses/example.com/alice2')

  expect(hidden.statusCode).toBe(200)
  expect(hidden.json().address.private).toBe(true)
  expect(created.statusCode).toBe(403)

  await app.close()
})

test('a key deletes only the addresses it created', async () => {
  const { repo, app, owner, member } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: member.pubkey })
  await request(app, signer(), 'PUT', '/addresses/example.com/carol')
  await request(app, member, 'PUT', '/addresses/example.com/alice')

  const others = await Promise.all(
    ['bob', 'carol'].map((localPart) => request(app, member, 'DELETE', `/addresses/example.com/${localPart}`)),
  )
  const own = await request(app, member, 'DELETE', '/addresses/example.com/alice')

  expect(others.map((response) => response.statusCode)).toEqual([404, 404])
  expect(own.statusCode).toBe(204)
  expect((await repo.listAddresses('example.com')).map((address) => address.localPart)).toEqual(['bob', 'carol'])

  await app.close()
})

test('the owner manages the addresses others created, and takes over the one it points elsewhere', async () => {
  const { repo, app, owner, member } = await setup()
  await request(app, member, 'PUT', '/addresses/example.com/alice')
  await request(app, member, 'PUT', '/addresses/example.com/zoe')

  const listed = await request(app, owner, 'GET', '/domains/example.com/addresses')
  expect(listed.json().addresses.map((address: { createdBy: string }) => address.createdBy)).toEqual([
    member.pubkey,
    member.pubkey,
  ])

  await request(app, owner, 'PUT', '/domains/example.com/addresses/alice', { pubkey: member.pubkey, private: true })
  expect(await repo.findAddress('example.com', 'alice')).toMatchObject({ private: true, createdBy: member.pubkey })

  await request(app, owner, 'PUT', '/domains/example.com/addresses/alice', { pubkey: npubEncode(owner.pubkey) })
  expect(await repo.findAddress('example.com', 'alice')).toMatchObject({
    pubkey: owner.pubkey,
    createdBy: owner.pubkey,
  })

  expect((await request(app, owner, 'DELETE', '/domains/example.com/addresses/zoe')).statusCode).toBe(204)
  expect((await request(app, member, 'GET', '/domains')).json().addresses).toEqual([])

  await app.close()
})

test('an address created on a shared domain resolves in NIP-05 and goes away with the claim', async () => {
  const { repo, app, owner, member } = await setup()
  await request(app, member, 'PUT', '/addresses/example.com/alice')

  const nip05 = await app.inject({ method: 'GET', url: '/nip05/example.com?name=alice' })
  expect(nip05.json()).toEqual({ names: { alice: member.pubkey } })

  await request(app, owner, 'DELETE', '/domains/example.com')
  expect(await repo.findAddress('example.com', 'alice')).toBeNull()

  await app.close()
})
