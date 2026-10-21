import type { FastifyInstance, FastifyRequest } from 'fastify'
import { normalizeDomain } from '../domain.js'
import { parsePubkey } from '../nostr.js'
import { checkServerRecords } from '../records.js'
import type { ApiConfig, DnsLookup, DomainRepository, DomainSummary } from '../types.js'
import { authenticateAdmin } from './auth.js'

type DomainRequest = FastifyRequest<{ Params: { domain: string } }>

type KeyRequest = FastifyRequest<{ Params: { pubkey: string } }>

type SettingsRequest = FastifyRequest<{ Body: { openRegistration?: unknown } | undefined }>

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

    const [domains, suspensions, allowedKeys, settings, abuseReports, serverRecords] = await Promise.all([
      repo.listAllDomains(),
      repo.listSuspensions(),
      repo.listAllowedKeys(),
      repo.findSettings(),
      repo.listAbuseReports(),
      checkServerRecords(config, dns),
    ])
    return reply.send({
      domains: domains.map(present),
      suspensions,
      allowedKeys,
      settings,
      abuseReports,
      serverRecords,
    })
  })

  app.put('/admin/settings', async (request: SettingsRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const openRegistration = request.body?.openRegistration
    if (typeof openRegistration !== 'boolean') return reply.code(400).send({ error: 'invalid_settings' })

    const settings = await repo.updateSettings({ openRegistration })
    request.log.info({ settings, admin }, 'Changed the settings of the server')
    return reply.send({ settings })
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

  // The path takes an npub or a hex key.
  app.put('/admin/allowed-keys/:pubkey', async (request: KeyRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const pubkey = parsePubkey(request.params.pubkey)
    if (!pubkey) return reply.code(400).send({ error: 'invalid_pubkey' })

    const existing = await repo.isAllowedKey(pubkey)
    const allowedKey = await repo.allowKey(pubkey)
    if (!existing) request.log.info({ pubkey, admin }, 'Allowed a key to connect domains')
    return reply.code(existing ? 200 : 201).send({ allowedKey })
  })

  app.delete('/admin/allowed-keys/:pubkey', async (request: KeyRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const pubkey = parsePubkey(request.params.pubkey)
    if (!pubkey || !(await repo.disallowKey(pubkey))) return reply.code(404).send({ error: 'allowed_key_not_found' })

    request.log.info({ pubkey, admin }, 'Took back the right of a key to connect domains')
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
