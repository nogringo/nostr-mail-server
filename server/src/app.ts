import Fastify, { type FastifyError } from 'fastify'
import { registerAddressRoutes } from './handlers/addresses.js'
import { registerDomainRoutes } from './handlers/domains.js'
import { registerNip05Routes } from './handlers/nip05.js'
import type { RelayNetwork } from './relays.js'
import type { DnsLookup, DomainConfig, DomainRepository } from './types.js'

export function buildApp(
  repo: DomainRepository,
  config: DomainConfig,
  dns: DnsLookup,
  relays: RelayNetwork,
  { logger = false }: { logger?: boolean } = {},
) {
  const app = Fastify({ logger })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) return reply.send(error)

    request.log.error({ error }, 'Request failed')
    return reply.code(500).send({ error: 'internal_error' })
  })

  app.get('/healthz', async () => 'ok')
  registerDomainRoutes(app, repo, { config, dns, relays })
  registerAddressRoutes(app, repo)
  registerNip05Routes(app, repo)

  return app
}
