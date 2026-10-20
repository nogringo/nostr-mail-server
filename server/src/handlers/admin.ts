import type { FastifyInstance } from 'fastify'
import type { DomainRepository, DomainSummary } from '../types.js'
import { authenticateAdmin } from './auth.js'

// What the operator of the server sees, authenticated with NIP-98 by a key of ADMIN_PUBKEYS.
export function registerAdminRoutes(app: FastifyInstance, repo: DomainRepository, admins: string[]): void {
  app.get('/admin/domains', async (request, reply) => {
    if (authenticateAdmin(request, reply, admins) === null) return reply

    const domains = await repo.listAllDomains()
    return reply.send({ domains: domains.map(present) })
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
