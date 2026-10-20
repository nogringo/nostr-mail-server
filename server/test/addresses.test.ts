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
  signer,
  verifyDomain,
} from './helpers.js'

async function setup() {
  const repo = new MemoryDomainRepository()
  const app = buildApp(repo, apiConfig, new FakeDns(), new FakeRelayNetwork())
  const owner = signer()
  await verifyDomain(repo, 'example.com', owner.pubkey)
  return { repo, app, owner }
}

test('PUT creates an address from an npub and stores the hex pubkey', async () => {
  const { repo, app, owner } = await setup()
  const bob = signer()

  const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/Bob', {
    pubkey: npubEncode(bob.pubkey),
  })

  expect(response.statusCode).toBe(201)
  expect(response.json()).toEqual({
    address: {
      localPart: 'bob',
      address: 'bob@example.com',
      pubkey: bob.pubkey,
      createdAt: expect.any(String),
    },
  })
  expect((await repo.findAddress('example.com', 'bob'))?.ownerPubkey).toBe(owner.pubkey)

  await app.close()
})

test('PUT on an existing address points it at the new pubkey with 200', async () => {
  const { app, owner } = await setup()
  const first = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: signer().pubkey })

  const carol = signer()
  const second = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: carol.pubkey })

  expect(second.statusCode).toBe(200)
  expect(second.json().address.pubkey).toBe(carol.pubkey)
  expect(second.json().address.createdAt).toBe(first.json().address.createdAt)

  await app.close()
})

test('GET lists the addresses of the domain', async () => {
  const { app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/zoe', { pubkey: signer().pubkey })
  await request(app, owner, 'PUT', '/domains/example.com/addresses/alice', { pubkey: owner.pubkey })

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
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: signer().pubkey })

  const deleted = await request(app, owner, 'DELETE', '/domains/example.com/addresses/bob')
  const again = await request(app, owner, 'DELETE', '/domains/example.com/addresses/bob')

  expect(deleted.statusCode).toBe(204)
  expect(again.statusCode).toBe(404)
  expect(again.json()).toEqual({ error: 'address_not_found' })

  await app.close()
})

test('only the verified owner manages addresses', async () => {
  const { repo, app } = await setup()
  const claimant = signer()
  await repo.createDomain(claim('pending.example', claimant.pubkey))

  const stranger = await request(app, signer(), 'GET', '/domains/example.com/addresses')
  const unverified = await request(app, claimant, 'PUT', '/domains/pending.example/addresses/bob', {
    pubkey: claimant.pubkey,
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
  const added = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: owner.pubkey })

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
    pubkey: owner.pubkey,
  })

  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error })

  await app.close()
})

test.each([{ pubkey: 'npub1typo' }, { pubkey: 'abc' }, { pubkey: 42 }, {}])(
  'PUT refuses the body %j with invalid_pubkey',
  async (body) => {
    const { app, owner } = await setup()

    const response = await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', body)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_pubkey' })

    await app.close()
  },
)

test('the addresses go away when another key takes the domain over', async () => {
  const { repo, app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: signer().pubkey })

  await verifyDomain(repo, 'example.com', signer().pubkey)

  expect(await repo.listAddresses('example.com')).toEqual([])

  await app.close()
})

test('the addresses go away when the owner releases the domain', async () => {
  const { repo, app, owner } = await setup()
  await request(app, owner, 'PUT', '/domains/example.com/addresses/bob', { pubkey: signer().pubkey })

  await request(app, owner, 'DELETE', '/domains/example.com')

  expect(await repo.listAddresses('example.com')).toEqual([])

  await app.close()
})
