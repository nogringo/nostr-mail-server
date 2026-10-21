import Fastify, { type FastifyError } from 'fastify'
import { DomainSigners } from './bunker.js'
import { registerAbuseRoutes } from './handlers/abuse.js'
import { registerAddressRoutes } from './handlers/addresses.js'
import { registerAdminRoutes } from './handlers/admin.js'
import { registerCertificateRoutes } from './handlers/certificates.js'
import { registerDomainRoutes } from './handlers/domains.js'
import { registerNip05Routes } from './handlers/nip05.js'
import type { RelayNetwork } from './relays.js'
import type { SettingsStore } from './settings.js'
import type { ApiConfig, DnsLookup, DomainRepository } from './types.js'

export function buildApp(
  repo: DomainRepository,
  config: ApiConfig,
  dns: DnsLookup,
  relays: RelayNetwork,
  settings: SettingsStore,
  { logger = false, signers = new DomainSigners() }: { logger?: boolean; signers?: DomainSigners } = {},
) {
  const app = Fastify({ logger })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) return reply.send(error)

    request.log.error({ error }, 'Request failed')
    return reply.code(500).send({ error: 'internal_error' })
  })

  app.get('/healthz', async () => 'ok')
  registerDomainRoutes(app, repo, { config, dns, relays, signers, settings })
  registerAddressRoutes(app, repo)
  registerNip05Routes(app, repo)
  registerCertificateRoutes(app, repo)
  registerAdminRoutes(app, repo, { config, dns, relays, signers, settings })
  registerAbuseRoutes(app, repo, config.adminPubkeys)

  return app
}
