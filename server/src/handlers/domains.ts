import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { generateDkimKeyPair } from '../dkim.js'
import { normalizeDomain } from '../domain.js'
import { publishDomainLists } from '../lists.js'
import { generateKeyPair } from '../nostr.js'
import { checkRecords, expectedRecords } from '../records.js'
import type { RelayNetwork } from '../relays.js'
import type { DnsLookup, Domain, DomainConfig, DomainRepository, Suspension } from '../types.js'
import { authenticate } from './auth.js'

interface DomainParams {
  domain: string
}

type DomainRequest = FastifyRequest<{ Params: DomainParams }>

// Domain lifecycle, authenticated with NIP-98: the signing pubkey owns the
// claims it makes, and a claim becomes the domain's owner once its ownership
// TXT record is found.
export function registerDomainRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  { config, dns, relays }: { config: DomainConfig; dns: DnsLookup; relays: RelayNetwork },
): void {
  app.get('/domains', async (request, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const [domains, suspensions] = await Promise.all([repo.listDomains(pubkey), repo.listSuspensions()])
    const suspended = new Map(suspensions.map((suspension) => [suspension.domain, suspension]))
    return reply.send({
      domains: domains.map((domain) => present(domain, config, suspended.get(domain.domain) ?? null)),
    })
  })

  app.put('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name) return reply.code(400).send({ error: 'invalid_domain' })

    const existing = await repo.findDomain(name, pubkey)
    const suspension = await repo.findSuspension(name)
    if (existing) return reply.send({ domain: present(existing, config, suspension) })
    if (suspension) return reply.code(403).send({ error: 'domain_suspended' })

    const dkim = await generateDkimKeyPair()
    const bridge = generateKeyPair()
    const created = await repo.createDomain({
      domain: name,
      pubkey,
      verificationToken: randomBytes(16).toString('hex'),
      dkimSelector: config.dkimSelector,
      dkimPublicKey: dkim.publicKey,
      dkimPrivateKey: dkim.privateKey,
      bridgePubkey: bridge.pubkey,
      bridgePrivateKey: bridge.privateKey,
      blossomServers: config.blossomServers,
    })
    return reply.code(201).send({ domain: present(created, config, null) })
  })

  app.get('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(domain, config, await repo.findSuspension(domain.domain)) })
  })

  app.post('/domains/:domain/check', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (await repo.findSuspension(domain.domain)) return reply.code(403).send({ error: 'domain_suspended' })

    const checks = await checkRecords(domain, config, dns)
    const updated = await repo.recordChecks(domain.domain, pubkey, checks, checks.ownership.status === 'ok')
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })

    // Every check of a verified domain republishes its lists, so checking again
    // is how a failed publication is retried.
    if (updated.verifiedAt && !(await publishDomainLists(relays, updated, config))) {
      request.log.warn({ domain: updated.domain }, 'The lists of the domain key were not all published')
    }

    return reply.send({ domain: present(updated, config, null) })
  })

  app.delete('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name || !(await repo.deleteDomain(name, pubkey))) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.code(204).send()
  })
}

async function findOwnDomain(repo: DomainRepository, request: DomainRequest, pubkey: string): Promise<Domain | null> {
  const name = normalizeDomain(request.params.domain)
  return name ? repo.findDomain(name, pubkey) : null
}

// The private keys never leave the server.
function present(domain: Domain, config: DomainConfig, suspension: Suspension | null) {
  return {
    domain: domain.domain,
    verifiedAt: domain.verifiedAt,
    suspendedAt: suspension?.suspendedAt ?? null,
    checkedAt: domain.checkedAt,
    blossomServers: domain.blossomServers,
    createdAt: domain.createdAt,
    records: expectedRecords(domain, config).map((record) => ({
      ...record,
      check: domain.checks?.[record.id] ?? null,
    })),
  }
}
