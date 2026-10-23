import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isOwnerLocalPart, isReservedLocalPart, normalizeDotAtom, normalizeLocalPart } from '../address.js'
import { normalizeDomain } from '../domain.js'
import { parsePubkey } from '../nostr.js'
import type { Address, DeletedAddress, Domain, DomainRepository } from '../types.js'
import { authenticate } from './auth.js'

type DomainRequest = FastifyRequest<{ Params: { domain: string } }>

type AddressRequest = FastifyRequest<{
  Params: { domain: string; localPart: string }
  Body: { pubkey?: unknown; private?: unknown } | undefined
}>

// Addresses on a domain, managed with NIP-98 by its verified owner, and on a
// shared domain by the keys that created them. Each one points a local part at
// a pubkey, which NIP-05 then serves on the domain unless the address is private.
// A deleted address is kept aside, and nothing creates it again until the owner allows it.
export function registerAddressRoutes(app: FastifyInstance, repo: DomainRepository): void {
  app.get('/domains/:domain/addresses', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const [addresses, deleted] = await Promise.all([
      repo.listAddresses(domain.domain),
      repo.listDeletedAddresses(domain.domain),
    ])
    return reply.send({
      addresses: addresses.map(presentAddress),
      deletedAddresses: deleted.map(presentDeletedAddress),
    })
  })

  app.put('/domains/:domain/addresses/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const localPart = normalizeDotAtom(request.params.localPart)
    if (!localPart) return reply.code(400).send({ error: 'invalid_local_part' })
    if (isReservedLocalPart(localPart)) return reply.code(400).send({ error: 'reserved_local_part' })

    const target = parsePubkey(request.body?.pubkey)
    if (!target) return reply.code(400).send({ error: 'invalid_pubkey' })

    const isPrivate = request.body?.private ?? false
    if (typeof isPrivate !== 'boolean') return reply.code(400).send({ error: 'invalid_private' })

    // The owner creates NIP-05 names only, and manages the addresses the catch-all created too.
    const existing = await repo.findAddress(domain.domain, localPart)
    if (!existing && !normalizeLocalPart(localPart)) return reply.code(400).send({ error: 'invalid_local_part' })
    if (!existing && (await repo.isDeletedAddress(domain.domain, localPart))) {
      return reply.code(409).send({ error: 'address_deleted' })
    }

    const address = await repo.putAddress({
      domain: domain.domain,
      localPart,
      pubkey: target,
      ownerPubkey: pubkey,
      private: isPrivate,
    })
    return reply.code(existing ? 200 : 201).send({ address: presentAddress(address) })
  })

  app.delete('/domains/:domain/addresses/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const localPart = normalizeDotAtom(request.params.localPart)
    if (!localPart || !(await repo.deleteAddress(domain.domain, localPart))) {
      return reply.code(404).send({ error: 'address_not_found' })
    }

    return reply.code(204).send()
  })

  app.delete('/domains/:domain/deleted-addresses/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const localPart = normalizeDotAtom(request.params.localPart)
    if (!localPart || !(await repo.allowDeletedAddresses(domain.domain, localPart))) {
      return reply.code(404).send({ error: 'deleted_address_not_found' })
    }

    return reply.code(204).send()
  })

  app.delete('/domains/:domain/deleted-addresses', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    await repo.allowDeletedAddresses(domain.domain)
    return reply.code(204).send()
  })

  // Any key creates addresses for itself on a shared domain, and keeps managing them once it is no
  // longer shared.
  app.put('/addresses/:domain/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const localPart = normalizeLocalPart(request.params.localPart)
    if (!localPart) return reply.code(400).send({ error: 'invalid_local_part' })
    if (isReservedLocalPart(localPart) || isOwnerLocalPart(localPart)) {
      return reply.code(400).send({ error: 'reserved_local_part' })
    }

    const isPrivate = request.body?.private ?? false
    if (typeof isPrivate !== 'boolean') return reply.code(400).send({ error: 'invalid_private' })

    const name = normalizeDomain(request.params.domain)
    const domain = name ? await repo.findVerifiedDomain(name) : null
    const existing = domain && (await repo.findAddress(domain.domain, localPart))
    if (existing && existing.createdBy !== pubkey) return reply.code(409).send({ error: 'address_taken' })
    if (!domain || (!existing && !domain.shared)) return reply.code(403).send({ error: 'domain_not_shared' })
    if (!existing && (await repo.isDeletedAddress(domain.domain, localPart))) {
      return reply.code(409).send({ error: 'address_deleted' })
    }

    const address = await repo.putCreatedAddress({
      domain: domain.domain,
      localPart,
      pubkey,
      ownerPubkey: domain.pubkey,
      createdBy: pubkey,
      private: isPrivate,
    })
    if (!address) return reply.code(409).send({ error: 'address_taken' })

    return reply.code(existing ? 200 : 201).send({ address: presentAddress(address) })
  })

  app.delete('/addresses/:domain/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    const localPart = normalizeLocalPart(request.params.localPart)
    if (!name || !localPart || !(await repo.deleteAddress(name, localPart, pubkey))) {
      return reply.code(404).send({ error: 'address_not_found' })
    }

    return reply.code(204).send()
  })
}

// Returns the caller's verified domain, or null after sending why it cannot be managed.
async function findOwnedDomain(
  repo: DomainRepository,
  value: string,
  pubkey: string,
  reply: FastifyReply,
): Promise<Domain | null> {
  const name = normalizeDomain(value)
  const domain = name ? await repo.findDomain(name, pubkey) : null

  if (!domain) {
    reply.code(404).send({ error: 'domain_not_found' })
    return null
  }
  if (!domain.verifiedAt) {
    reply.code(409).send({ error: 'domain_not_verified' })
    return null
  }
  if (await repo.findSuspension(domain.domain)) {
    reply.code(403).send({ error: 'domain_suspended' })
    return null
  }

  return domain
}

export function presentAddress(address: Address) {
  return {
    domain: address.domain,
    localPart: address.localPart,
    address: `${address.localPart}@${address.domain}`,
    pubkey: address.pubkey,
    createdBy: address.createdBy,
    private: address.private,
    createdAt: address.createdAt,
  }
}

function presentDeletedAddress(deleted: DeletedAddress) {
  return {
    domain: deleted.domain,
    localPart: deleted.localPart,
    address: `${deleted.localPart}@${deleted.domain}`,
    deletedAt: deleted.deletedAt,
  }
}
