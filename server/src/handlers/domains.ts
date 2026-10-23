import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { nsecEncode } from 'nostr-tools/nip19'
import { hexToBytes } from 'nostr-tools/utils'
import { BunkerError, type DomainSigners, parseBunkerUrl } from '../bunker.js'
import { generateDkimKeyPair } from '../dkim.js'
import { normalizeDomain } from '../domain.js'
import { publishDomainLists } from '../lists.js'
import { generateKeyPair, parseNsec } from '../nostr.js'
import { checkRecords, expectedRecords } from '../records.js'
import type { RelayNetwork } from '../relays.js'
import type { SettingsStore } from '../settings.js'
import type {
  AbuseReport,
  ApiConfig,
  BridgeKey,
  DnsLookup,
  Domain,
  DomainConfig,
  DomainRepository,
  Nip05Lookup,
  Suspension,
} from '../types.js'
import { listOwnReports } from './abuse.js'
import { presentAddress } from './addresses.js'
import { authenticate } from './auth.js'

interface DomainParams {
  domain: string
}

type DomainRequest = FastifyRequest<{ Params: DomainParams }>

type KeyRequest = FastifyRequest<{ Params: DomainParams; Body: { nsec?: unknown; bunker?: unknown } | undefined }>

type Nip05Request = FastifyRequest<{ Params: DomainParams; Body: { nip05?: unknown } | undefined }>

type SharedRequest = FastifyRequest<{ Params: DomainParams; Body: { shared?: unknown } | undefined }>

// Domain lifecycle, authenticated with NIP-98: the signing pubkey owns the
// claims it makes, and a claim becomes the domain's owner once its ownership
// TXT record is found.
export function registerDomainRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  {
    config,
    dns,
    nip05Lookup,
    relays,
    signers,
    settings,
  }: {
    config: ApiConfig
    dns: DnsLookup
    nip05Lookup: Nip05Lookup
    relays: RelayNetwork
    signers: DomainSigners
    settings: SettingsStore
  },
): void {
  const publishLists = (domain: Domain) =>
    publishDomainLists(relays, signers.forDomain(domain), domain.blossomServers, settings.current)
  const canClaim = async (pubkey: string) =>
    config.adminPubkeys.includes(pubkey) || settings.current.openRegistration || (await repo.isAllowedKey(pubkey))

  // Every check of a verified domain republishes its lists, so checking again
  // is how a failed publication is retried.
  async function check(request: FastifyRequest, domain: Domain): Promise<Domain | null> {
    const checks = await checkRecords(domain, config, dns, nip05Lookup)
    const updated = await repo.recordChecks(domain.domain, domain.pubkey, checks, checks.ownership.status === 'ok')
    if (updated?.verifiedAt && !(await publishLists(updated))) {
      request.log.warn({ domain: updated.domain }, 'The lists of the domain key were not all published')
    }
    return updated
  }

  app.get('/domains', async (request, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const [domains, suspensions, allowed, addresses, shared] = await Promise.all([
      repo.listDomains(pubkey),
      repo.listSuspensions(),
      canClaim(pubkey),
      repo.listCreatedAddresses(pubkey),
      repo.listSharedDomains(),
    ])
    const suspended = new Map(suspensions.map((suspension) => [suspension.domain, suspension]))
    const owned = new Set(domains.filter((domain) => domain.verifiedAt).map((domain) => domain.domain))
    return reply.send({
      domains: await Promise.all(
        domains.map(async (domain) =>
          present(domain, config, suspended.get(domain.domain) ?? null, await listOwnReports(repo, domain)),
        ),
      ),
      canClaim: allowed,
      // Where this key creates addresses for itself, and those it created.
      sharedDomains: shared.filter((name) => !owned.has(name)),
      addresses: addresses.map(presentAddress),
    })
  })

  app.put('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const name = normalizeDomain(request.params.domain)
    if (!name) return reply.code(400).send({ error: 'invalid_domain' })

    const existing = await repo.findDomain(name, pubkey)
    const suspension = await repo.findSuspension(name)
    if (existing) {
      return reply.send({ domain: present(existing, config, suspension, await listOwnReports(repo, existing)) })
    }
    if (!(await canClaim(pubkey))) return reply.code(403).send({ error: 'not_allowed' })
    if (suspension) return reply.code(403).send({ error: 'domain_suspended' })

    const dkim = await generateDkimKeyPair()
    const bridge = generateKeyPair()
    const created = await repo.createDomain({
      domain: name,
      pubkey,
      verificationToken: randomBytes(16).toString('hex'),
      dkimSelector: config.dkimSelector,
      dkimPublicKey: dkim.publicKey,
      dkimPrivateKey: dkim.privateKey,
      bridgePubkey: bridge.pubkey,
      bridgePrivateKey: bridge.privateKey,
      blossomServers: settings.current.blossomServers,
    })
    return reply.code(201).send({ domain: present(created, config, null, []) })
  })

  app.get('/domains/:domain', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })

    const [suspension, reports] = await Promise.all([repo.findSuspension(domain.domain), listOwnReports(repo, domain)])
    return reply.send({ domain: present(domain, config, suspension, reports) })
  })

  app.post('/domains/:domain/check', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (await repo.findSuspension(domain.domain)) return reply.code(403).send({ error: 'domain_suspended' })

    const updated = await check(request, domain)
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(updated, config, null, await listOwnReports(repo, updated)) })
  })

  // The NIP-05 check depends on who serves it, so a change checks the domain again.
  app.put('/domains/:domain/nip05', async (request: Nip05Request, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (await repo.findSuspension(domain.domain)) return reply.code(403).send({ error: 'domain_suspended' })

    const nip05 = request.body?.nip05
    if (nip05 !== 'server' && nip05 !== 'owner') return reply.code(400).send({ error: 'invalid_nip05' })

    const changed = await repo.setNip05Host(domain.domain, pubkey, nip05)
    const updated = changed && (await check(request, changed))
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(updated, config, null, await listOwnReports(repo, updated)) })
  })

  app.put('/domains/:domain/shared', async (request: SharedRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (await repo.findSuspension(domain.domain)) return reply.code(403).send({ error: 'domain_suspended' })

    const shared = request.body?.shared
    if (typeof shared !== 'boolean') return reply.code(400).send({ error: 'invalid_shared' })

    const updated = await repo.setShared(domain.domain, pubkey, shared)
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })

    return reply.send({ domain: present(updated, config, null, await listOwnReports(repo, updated)) })
  })

  app.get('/domains/:domain/key', async (request: DomainRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (domain.bridgePrivateKey === null) return reply.code(409).send({ error: 'key_in_bunker' })

    return reply.header('cache-control', 'no-store').send({ nsec: nsecEncode(hexToBytes(domain.bridgePrivateKey)) })
  })

  app.put('/domains/:domain/key', async (request: KeyRequest, reply) => {
    const pubkey = authenticate(request, reply)
    if (pubkey === null) return reply

    const domain = await findOwnDomain(repo, request, pubkey)
    if (!domain) return reply.code(404).send({ error: 'domain_not_found' })
    if (await repo.findSuspension(domain.domain)) return reply.code(403).send({ error: 'domain_suspended' })

    let bridgeKey: BridgeKey
    if (request.body?.bunker !== undefined) {
      const pointer = parseBunkerUrl(request.body.bunker)
      if (!pointer) return reply.code(400).send({ error: 'invalid_bunker_url' })
      try {
        const connected = await signers.connect(pointer)
        bridgeKey = { bridgePubkey: connected.pubkey, bridgePrivateKey: null, bridgeBunker: connected.bunker }
      } catch (error) {
        if (!(error instanceof BunkerError)) throw error
        return reply.code(error.code === 'bunker_timeout' ? 504 : 502).send({ error: error.code })
      }
    } else {
      const key = parseNsec(request.body?.nsec)
      if (!key) return reply.code(400).send({ error: 'invalid_nsec' })
      bridgeKey = { bridgePubkey: key.pubkey, bridgePrivateKey: key.privateKey, bridgeBunker: null }
    }

    // The server reads every gift wrap sent to the domain key and replaces its lists.
    if (bridgeKey.bridgePubkey === pubkey) return reply.code(400).send({ error: 'owner_key' })
    if (bridgeKey.bridgePubkey !== domain.bridgePubkey && (await repo.hasBridgeKey(bridgeKey.bridgePubkey))) {
      return reply.code(409).send({ error: 'key_in_use' })
    }
    if (bridgeKey.bridgePrivateKey !== null && bridgeKey.bridgePrivateKey === domain.bridgePrivateKey) {
      return reply.send({ domain: present(domain, config, null, await listOwnReports(repo, domain)) })
    }

    const updated = await repo.replaceBridgeKey(domain.domain, pubkey, bridgeKey)
    if (!updated) return reply.code(404).send({ error: 'domain_not_found' })
    if (updated.verifiedAt && !(await publishLists(updated))) {
      request.log.warn({ domain: updated.domain }, 'The lists of the domain key were not all published')
    }

    return reply.send({ domain: present(updated, config, null, await listOwnReports(repo, updated)) })
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

// The private keys are left out: the owner reads the nsec of the domain key on its own route.
function present(domain: Domain, config: DomainConfig, suspension: Suspension | null, abuseReports: AbuseReport[]) {
  return {
    domain: domain.domain,
    bridgePubkey: domain.bridgePubkey,
    bridgeSigner: domain.bridgeBunker ? 'bunker' : 'server',
    verifiedAt: domain.verifiedAt,
    suspendedAt: suspension?.suspendedAt ?? null,
    checkedAt: domain.checkedAt,
    blossomServers: domain.blossomServers,
    nip05: domain.nip05,
    shared: domain.shared,
    createdAt: domain.createdAt,
    records: expectedRecords(domain, config).map((record) => ({
      ...record,
      check: domain.checks?.[record.id] ?? null,
    })),
    abuseReports,
  }
}
