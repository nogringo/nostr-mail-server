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
