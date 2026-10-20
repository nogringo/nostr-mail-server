import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { generateDkimKeyPair } from '../dkim.js'
import { normalizeDomain } from '../domain.js'
import { verifyNip98 } from '../nip98.js'
import { checkRecords, expectedRecords } from '../records.js'
import type { DnsLookup, Domain, DomainConfig, DomainRepository } from '../types.js'

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
  { config, dns }: { config: DomainConfig; dns: DnsLookup },
): void {
  app.get('/domains', async (request, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domains = await repo.listDomains(pubkey)
    return reply.send({ domains: domains.map((domain) => present(domain, config)) })
  })

  app.put('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name) return reply.code(400).send({ error: 'invalid_domain' })

    const existing = await repo.findDomain(name, pubkey)
    if (existing) return reply.send({ domain: present(existing, config) })

    const dkim = await generateDkimKeyPair()
    const created = await repo.createDomain({
      domain: name,
      pubkey,
      verificationToken: randomBytes(16).toString('hex'),
      dkimSelector: config.dkimSelector,
      dkimPublicKey: dkim.publicKey,
      dkimPrivateKey: dkim.privateKey,
    })
    return reply.code(201).send({ domain: present(created, config) })
  })

  app.get('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(domain, config) })
  })

  app.post('/domains/:domain/check', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    const checks = await checkRecords(domain, config, dns)
    const updated = await repo.recordChecks(domain.domain, pubkey, checks, checks.ownership.status === 'ok')
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(updated, config) })
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

// The private DKIM key never leaves the server.
function present(domain: Domain, config: DomainConfig) {
  return {
    domain: domain.domain,
    verifiedAt: domain.verifiedAt,
    checkedAt: domain.checkedAt,
    createdAt: domain.createdAt,
    records: expectedRecords(domain, config).map((record) => ({
      ...record,
      check: domain.checks?.[record.id] ?? null,
    })),
  }
}

// Returns the authenticated pubkey, or null after sending a 401 with the reason.
function authenticate(request: FastifyRequest, reply: FastifyReply): string | null {
  const result = verifyNip98({
    authorization: request.headers.authorization,
    method: request.method,
    host: request.headers.host ?? '',
    path: request.url,
    nowSeconds: Math.floor(Date.now() / 1000),
  })

  if (!result.ok) {
    reply.header('www-authenticate', 'Nostr').code(401).send({ error: result.reason })
    return null
  }

  return result.pubkey
}
