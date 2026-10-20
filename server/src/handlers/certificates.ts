import type { FastifyInstance, FastifyRequest } from 'fastify'
import { normalizeDomain } from '../domain.js'
import type { DomainRepository } from '../types.js'

type AskRequest = FastifyRequest<{ Querystring: { domain?: unknown } }>

// The ask endpoint of Caddy's on-demand TLS: a certificate only for a verified
// domain, so pointing any name here does not make it request one.
export function registerCertificateRoutes(app: FastifyInstance, repo: DomainRepository): void {
  app.get('/certificates/allowed', async (request: AskRequest, reply) => {
    const { domain } = request.query
    const name = typeof domain === 'string' ? normalizeDomain(domain) : null
    const allowed = name !== null && (await repo.findVerifiedDomain(name)) !== null

    return reply.code(allowed ? 200 : 404).send()
  })
}
