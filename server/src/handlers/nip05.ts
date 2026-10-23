import type { FastifyInstance, FastifyRequest } from 'fastify'
import { normalizeLocalPart, SMTP_LOCAL_PART } from '../address.js'
import { normalizeDomain, normalizeHost } from '../domain.js'
import { decodeNpub } from '../nostr.js'
import type { DomainRepository } from '../types.js'

type Nip05Request = FastifyRequest<{ Querystring: { name?: unknown } }>

// NIP-05 for the connected domains, whose HTTPS points at this server: the
// domain is the Host header, and only a verified domain resolves names.
export function registerNip05Routes(app: FastifyInstance, repo: DomainRepository): void {
  app.get('/.well-known/nostr.json', async (request: Nip05Request, reply) => {
    reply.header('access-control-allow-origin', '*')

    const { name } = request.query
    if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'name_required' })

    const domain = normalizeDomain(normalizeHost(request.headers.host ?? ''))
    const localPart = normalizeLocalPart(name)
    if (!domain || !localPart) return reply.send({ names: {} })

    const pubkey = await resolve(repo, domain, localPart)
    return reply.send({ names: pubkey ? { [localPart]: pubkey } : {} })
  })
}

async function resolve(repo: DomainRepository, domain: string, localPart: string): Promise<string | null> {
  const verified = await repo.findVerifiedDomain(domain)
  if (!verified) return null
  if (localPart === SMTP_LOCAL_PART) return verified.bridgePubkey

  const npubPubkey = decodeNpub(localPart)
  if (npubPubkey) return npubPubkey

  const address = await repo.findAddress(domain, localPart)
  return address && !address.private ? address.pubkey : null
}
