import Fastify, { type FastifyError } from 'fastify'
import { registerDomainRoutes } from './handlers/domains.js'
import type { DnsLookup, DomainConfig, DomainRepository } from './types.js'

export function buildApp(
  repo: DomainRepository,
  config: DomainConfig,
  dns: DnsLookup,
  { logger = false }: { logger?: boolean } = {},
) {
  const app = Fastify({ logger })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) return reply.send(error)

    request.log.error({ error }, 'Request failed')
    return reply.code(500).send({ error: 'internal_error' })
  })

  app.get('/healthz', async () => 'ok')
  registerDomainRoutes(app, repo, { config, dns })

  return app
}
