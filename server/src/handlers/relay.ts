import websocket from '@fastify/websocket'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { verifyEvent } from 'nostr-tools/pure'
import { RELAY_PATH } from '../config.js'
import { asNostrEvent, findTagValue } from '../nostr.js'
import { GIFT_WRAP_KIND, MAX_CLOCK_SKEW_SECONDS, type Outbox } from '../outbox.js'
import type { DomainRepository } from '../types.js'

// Clients move mail over 32 KB to Blossom, so a wrap stays well under this.
const MAX_MESSAGE_BYTES = 256 * 1024

type Reply = ['OK', string, boolean, string] | ['CLOSED', string, string] | ['NOTICE', string]

interface Relay {
  repo: DomainRepository
  outbox: Pick<Outbox, 'receive'>
  log: FastifyBaseLogger
}

// A NIP-01 relay that takes the gift wraps sent to the domain keys and serves
// nothing: the one way in for the mail the domains send.
export function registerRelayRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  outbox: Pick<Outbox, 'receive'>,
): void {
  app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } })
  app.register(async (instance) => {
    instance.get(RELAY_PATH, { websocket: true }, (socket, request) => {
      const relay = { repo, outbox, log: request.log }
      socket.on('message', (data) => {
        void answer(relay, String(data)).then((reply) => {
          if (reply) socket.send(JSON.stringify(reply))
        })
      })
    })
  })
}

async function answer(relay: Relay, message: string): Promise<Reply | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    parsed = null
  }
  if (!Array.isArray(parsed)) return ['NOTICE', 'invalid: not a NIP-01 message']

  const [type, value] = parsed
  if (type === 'EVENT') return take(relay, value)
  if (type === 'REQ') return ['CLOSED', String(value), 'blocked: this relay only takes the mail to send']
  if (type === 'CLOSE') return null
  return ['NOTICE', 'invalid: this relay only takes EVENT messages']
}

async function take({ repo, outbox, log }: Relay, value: unknown): Promise<Reply> {
  const wrap = asNostrEvent(value)
  if (!wrap) return ['NOTICE', 'invalid: not an event']
  if (!verifyEvent(wrap)) return ['OK', wrap.id, false, 'invalid: bad id or signature']
  if (wrap.kind !== GIFT_WRAP_KIND) return ['OK', wrap.id, false, 'blocked: this relay only takes gift wraps']
  if (wrap.created_at > Math.floor(Date.now() / 1000) + MAX_CLOCK_SKEW_SECONDS) {
    return ['OK', wrap.id, false, 'invalid: dated in the future']
  }

  try {
    const bridgePubkey = findTagValue(wrap.tags, 'p')
    if (!bridgePubkey || !(await repo.findVerifiedDomainByBridgePubkey(bridgePubkey))) {
      return ['OK', wrap.id, false, 'blocked: not addressed to a domain of this server']
    }
    const refusal = await outbox.receive(wrap, bridgePubkey)
    return refusal ? ['OK', wrap.id, false, `blocked: ${refusal}`] : ['OK', wrap.id, true, '']
  } catch (error) {
    log.error({ wrapId: wrap.id, error }, 'A gift wrap could not be queued')
    // Nostr Mail clients send a rate-limited event again later, and give up on an error.
    return ['OK', wrap.id, false, 'rate-limited: the email cannot be taken now, try again later']
  }
}
