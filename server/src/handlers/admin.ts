import type { FastifyInstance, FastifyRequest } from 'fastify'
import { normalizeDomain } from '../domain.js'
import { checkServerRecords } from '../records.js'
import type { ApiConfig, DnsLookup, DomainRepository, DomainSummary } from '../types.js'
import { authenticateAdmin } from './auth.js'

type DomainRequest = FastifyRequest<{ Params: { domain: string } }>

// What the operator of the server sees and does, authenticated with NIP-98 by a key of ADMIN_PUBKEYS.
export function registerAdminRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  { config, dns }: { config: ApiConfig; dns: DnsLookup },
): void {
  const admins = config.adminPubkeys

  // The server's own records are checked live, so a reload shows a fix.
  app.get('/admin/domains', async (request, reply) => {
    if (authenticateAdmin(request, reply, admins) === null) return reply

    const [domains, suspensions, abuseReports, serverRecords] = await Promise.all([
      repo.listAllDomains(),
      repo.listSuspensions(),
      repo.listAbuseReports(),
      checkServerRecords(config, dns),
    ])
    return reply.send({ domains: domains.map(present), suspensions, abuseReports, serverRecords })
  })

  app.put('/admin/domains/:domain/suspension', async (request: DomainRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name) return reply.code(400).send({ error: 'invalid_domain' })

    const existing = await repo.findSuspension(name)
    const suspension = await repo.suspendDomain(name)
    if (!existing) request.log.info({ domain: name, admin }, 'Suspended a domain')
    return reply.code(existing ? 200 : 201).send({ suspension })
  })

  app.delete('/admin/domains/:domain/suspension', async (request: DomainRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name || !(await repo.unsuspendDomain(name))) return reply.code(404).send({ error: 'suspension_not_found' })

    request.log.info({ domain: name, admin }, 'Lifted the suspension of a domain')
    return reply.code(204).send()
  })
}

// The private keys never leave the server.
function present(domain: DomainSummary) {
  return {
    domain: domain.domain,
    pubkey: domain.pubkey,
    verifiedAt: domain.verifiedAt,
    checkedAt: domain.checkedAt,
    createdAt: domain.createdAt,
    addressCount: domain.addressCount,
    checks: domain.checks,
  }
}
