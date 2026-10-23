import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { normalizeLocalPart, SMTP_LOCAL_PART } from '../address.js'
import { normalizeDomain, normalizeHost } from '../domain.js'
import { decodeNpub } from '../nostr.js'
import type { DomainRepository } from '../types.js'

type Nip05Request = FastifyRequest<{ Querystring: { name?: unknown } }>

type RelayedRequest = FastifyRequest<{ Params: { domain: string }; Querystring: { name?: unknown } }>

// NIP-05 for the connected domains: only a verified domain resolves names.
export function registerNip05Routes(app: FastifyInstance, repo: DomainRepository): void {
  // A domain whose A record points here: the domain is the Host header.
  app.get('/.well-known/nostr.json', (request: Nip05Request, reply) =>
    answer(repo, normalizeHost(request.headers.host ?? ''), request, reply),
  )

  // A domain whose own website relays its nostr.json here, often with this server as the Host.
  app.get('/nip05/:domain', (request: RelayedRequest, reply) => answer(repo, request.params.domain, request, reply))
}

async function answer(repo: DomainRepository, host: string, request: Nip05Request, reply: FastifyReply) {
  reply.header('access-control-allow-origin', '*')

  const { name } = request.query
  if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'name_required' })

  const domain = normalizeDomain(host)
  const localPart = normalizeLocalPart(name)
  if (!domain || !localPart) return reply.send({ names: {} })

  const pubkey = await resolve(repo, domain, localPart)
  return reply.send({ names: pubkey ? { [localPart]: pubkey } : {} })
}

async function resolve(repo: DomainRepository, domain: string, localPart: string): Promise<string | null> {
  const verified = await repo.findVerifiedDomain(domain)
  if (!verified) return null
  if (localPart === SMTP_LOCAL_PART) return verified.bridgePubkey

  const npubPubkey = decodeNpub(localPart)
  if (npubPubkey) return npubPubkey

  // A disabled address is hidden too, or Nostr clients would write to its key around it.
  const address = await repo.findAddress(domain, localPart)
  return address && !address.private && address.enabled ? address.pubkey : null
}
