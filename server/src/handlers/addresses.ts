import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isReservedLocalPart, normalizeLocalPart } from '../address.js'
import { normalizeDomain } from '../domain.js'
import { parsePubkey } from '../nostr.js'
import type { Address, Domain, DomainRepository } from '../types.js'
import { authenticate } from './auth.js'

type DomainRequest = FastifyRequest<{ Params: { domain: string } }>

type AddressRequest = FastifyRequest<{
  Params: { domain: string; localPart: string }
  Body: { pubkey?: unknown; private?: unknown } | undefined
}>

// Addresses on a domain, managed with NIP-98 by its verified owner. Each one
// points a local part at a pubkey, which NIP-05 then serves on the domain
// unless the address is private.
export function registerAddressRoutes(app: FastifyInstance, repo: DomainRepository): void {
  app.get('/domains/:domain/addresses', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const addresses = await repo.listAddresses(domain.domain)
    return reply.send({ addresses: addresses.map(present) })
  })

  app.put('/domains/:domain/addresses/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const localPart = normalizeLocalPart(request.params.localPart)
    if (!localPart) return reply.code(400).send({ error: 'invalid_local_part' })
    if (isReservedLocalPart(localPart)) return reply.code(400).send({ error: 'reserved_local_part' })

    const target = parsePubkey(request.body?.pubkey)
    if (!target) return reply.code(400).send({ error: 'invalid_pubkey' })

    const isPrivate = request.body?.private ?? false
    if (typeof isPrivate !== 'boolean') return reply.code(400).send({ error: 'invalid_private' })

    const existing = await repo.findAddress(domain.domain, localPart)
    const address = await repo.putAddress({
      domain: domain.domain,
      localPart,
      pubkey: target,
      ownerPubkey: pubkey,
      private: isPrivate,
    })
    return reply.code(existing ? 200 : 201).send({ address: present(address) })
  })

  app.delete('/domains/:domain/addresses/:localPart', async (request: AddressRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnedDomain(repo, request.params.domain, pubkey, reply)
    if (domain === null) return reply

    const localPart = normalizeLocalPart(request.params.localPart)
    if (!localPart || !(await repo.deleteAddress(domain.domain, localPart))) {
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

function present(address: Address) {
  return {
    localPart: address.localPart,
    address: `${address.localPart}@${address.domain}`,
    pubkey: address.pubkey,
    private: address.private,
    createdAt: address.createdAt,
  }
}
