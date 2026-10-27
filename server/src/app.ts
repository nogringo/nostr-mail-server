import Fastify, { type FastifyError, type FastifyRequest } from 'fastify'
import { DomainSigners } from './bunker.js'
import { registerAbuseRoutes } from './handlers/abuse.js'
import { registerAddressRoutes } from './handlers/addresses.js'
import { registerAdminRoutes } from './handlers/admin.js'
import { registerCertificateRoutes } from './handlers/certificates.js'
import { registerDomainRoutes } from './handlers/domains.js'
import { registerNip05Routes } from './handlers/nip05.js'
import { fetchNip05 } from './nip05.js'
import { QuotaKeeper } from './quotas.js'
import type { RelayNetwork } from './relays.js'
import type { SettingsStore } from './settings.js'
import type { ApiConfig, DnsLookup, DomainRepository, Nip05Lookup } from './types.js'

// A reverse proxy on the same host or a private network, such as Caddy in deploy/, names the client in
// X-Forwarded-For. A client reaching the server directly is never trusted with it.
const TRUSTED_PROXIES = 'loopback, linklocal, uniquelocal'

export function buildApp(
  repo: DomainRepository,
  config: ApiConfig,
  dns: DnsLookup,
  relays: RelayNetwork,
  settings: SettingsStore,
  {
    logger = false,
    signers = new DomainSigners(),
    nip05Lookup = fetchNip05,
    quotas = new QuotaKeeper(repo, settings, config.adminPubkeys),
  }: { logger?: boolean; signers?: DomainSigners; nip05Lookup?: Nip05Lookup; quotas?: QuotaKeeper } = {},
) {
  const app = Fastify({
    // No client IP address in the logs, which would keep a history of who used the server.
    logger: logger && { serializers: { req: ({ method, url, host }: FastifyRequest) => ({ method, url, host }) } },
    trustProxy: TRUSTED_PROXIES,
  })

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) return reply.send(error)

    request.log.error({ error }, 'Request failed')
    return reply.code(500).send({ error: 'internal_error' })
  })

  app.get('/healthz', async () => 'ok')
  registerDomainRoutes(app, repo, { config, dns, nip05Lookup, relays, signers, settings, quotas })
  registerAddressRoutes(app, repo, quotas)
  registerNip05Routes(app, repo)
  registerCertificateRoutes(app, repo)
  registerAdminRoutes(app, repo, { config, dns, relays, signers, settings })
  registerAbuseRoutes(app, repo, config.adminPubkeys)

  return app
}
