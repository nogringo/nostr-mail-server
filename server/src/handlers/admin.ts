import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DomainSigners } from '../bunker.js'
import { normalizeDomain } from '../domain.js'
import { listsTargets, publishEveryDomainLists } from '../lists.js'
import { parsePubkey } from '../nostr.js'
import { parseQuotas } from '../quotas.js'
import { checkServerRecords } from '../records.js'
import type { RelayNetwork } from '../relays.js'
import { parseSettingsChanges, type SettingsStore } from '../settings.js'
import type { ApiConfig, DnsLookup, DomainRepository, DomainSummary } from '../types.js'
import { authenticateAdmin } from './auth.js'

type DomainRequest = FastifyRequest<{ Params: { domain: string } }>

type KeyRequest = FastifyRequest<{ Params: { pubkey: string } }>

type KeyQuotasRequest = FastifyRequest<{ Params: { pubkey: string }; Body: { quotas?: unknown } | undefined }>

type SettingsRequest = FastifyRequest<{ Body: unknown }>

// What the operator of the server sees and does, authenticated with NIP-98 by a key of ADMIN_PUBKEYS.
export function registerAdminRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  {
    config,
    dns,
    relays,
    signers,
    settings,
  }: { config: ApiConfig; dns: DnsLookup; relays: RelayNetwork; signers: DomainSigners; settings: SettingsStore },
): void {
  const admins = config.adminPubkeys

  // The server's own records are checked live, so a reload shows a fix.
  app.get('/admin/domains', async (request, reply) => {
    if (authenticateAdmin(request, reply, admins) === null) return reply

    const [domains, suspensions, allowedKeys, keyQuotas, abuseReports, serverRecords] = await Promise.all([
      repo.listAllDomains(),
      repo.listSuspensions(),
      repo.listAllowedKeys(),
      repo.listKeyQuotas(),
      repo.listAbuseReports('admin'),
      checkServerRecords(config, dns),
    ])
    return reply.send({
      domains: domains.map(present),
      suspensions,
      allowedKeys,
      keyQuotas,
      settings: settings.current,
      abuseReports,
      serverRecords,
    })
  })

  // Takes any of the settings; the others keep their value.
  app.patch('/admin/settings', async (request: SettingsRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const parsed = parseSettingsChanges(request.body)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })

    const before = settings.current
    const after = await settings.update(parsed.changes)
    request.log.info({ changes: parsed.changes, admin }, 'Changed the settings of the server')

    if (!sameUrls(before.indexerRelays, after.indexerRelays)) {
      void publishEveryDomainLists(repo, relays, signers, listsTargets(config, after)).then(
        (failed) => request.log.info({ failed }, 'Published the lists of the domain keys on the new indexers'),
        (error) => request.log.error({ error }, 'The lists of the domain keys could not be published'),
      )
    }
    return reply.send({ settings: after })
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

  // Replaces the quotas the key had of its own. The path takes an npub or a hex key.
  app.put('/admin/key-quotas/:pubkey', async (request: KeyQuotasRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const pubkey = parsePubkey(request.params.pubkey)
    if (!pubkey) return reply.code(400).send({ error: 'invalid_pubkey' })
    const quotas = parseQuotas(request.body?.quotas)
    if (!quotas || !Object.keys(quotas).length) return reply.code(400).send({ error: 'invalid_quotas' })

    const existing = await repo.findKeyQuotas(pubkey)
    const keyQuotas = await repo.putKeyQuotas(pubkey, quotas)
    request.log.info({ pubkey, quotas, admin }, 'Set the quotas of a key')
    return reply.code(existing ? 200 : 201).send({ keyQuotas })
  })

  app.delete('/admin/key-quotas/:pubkey', async (request: KeyRequest, reply) => {
    const admin = authenticateAdmin(request, reply, admins)
    if (admin === null) return reply

    const pubkey = parsePubkey(request.params.pubkey)
    if (!pubkey || !(await repo.deleteKeyQuotas(pubkey))) {
      return reply.code(404).send({ error: 'key_quotas_not_found' })
    }

    request.log.info({ pubkey, admin }, 'Gave a key the quotas of the server back')
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
    shared: domain.shared,
    addressCount: domain.addressCount,
    checks: domain.checks,
  }
}

function sameUrls(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((url, index) => url === right[index])
}
