import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyNip98 } from '../nip98.js'

// Returns the authenticated pubkey, or null after sending a 401 with the reason.
export function authenticate(request: FastifyRequest, reply: FastifyReply): string | null {
  const result = verifyNip98({
    authorization: request.headers.authorization,
    method: request.method,
    host: request.headers.host ?? '',
    path: request.url,
    nowSeconds: Math.floor(Date.now() / 1000),
  })

  if (!result.ok) {
    reply.header('www-authenticate', 'Nostr').code(401).send({ error: result.reason })
    return null
  }

  return result.pubkey
}

// Returns the authenticated pubkey when it is an admin, or null after sending a 401 or a 403.
export function authenticateAdmin(request: FastifyRequest, reply: FastifyReply, admins: string[]): string | null {
  const pubkey = authenticate(request, reply)
  if (pubkey === null) return null

  if (!admins.includes(pubkey)) {
    reply.code(403).send({ error: 'not_admin' })
    return null
  }

  return pubkey
}
