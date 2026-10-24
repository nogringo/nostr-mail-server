import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type NostrEvent, verifyEvent } from 'nostr-tools/pure'
import { AUTH_KIND, AUTH_TAG_BYTES, collectLimited } from '../blossom.js'
import { normalizeHostname } from '../domain.js'
import { authorizationEvent } from '../nip98.js'
import { findTagValue } from '../nostr.js'
import type { Outbox } from '../outbox.js'
import type { SettingsStore } from '../settings.js'
import type { ApiConfig, DomainRepository } from '../types.js'

// BUD-01 names a blob by its hash, an extension allowed.
const BLOB_PATH = /^([0-9a-f]{64})(\.[a-z0-9]+)?$/
const MAX_CLOCK_SKEW_SECONDS = 60

type BlobRequest = FastifyRequest<{ Params: { blob: string } }>

// The Blossom server the domain keys announce (BUD-01 and BUD-02), at the root
// of its own host: clients upload the blobs of the mail they send, which the
// outbox reads from here. Any key may upload, as clients often sign with a
// throwaway one, and what no email takes goes after a day.
export function registerBlossomRoutes(
  app: FastifyInstance,
  repo: DomainRepository,
  {
    config,
    settings,
    outbox,
  }: { config: Pick<ApiConfig, 'blossomUrl'>; settings: SettingsStore; outbox: Pick<Outbox, 'blobUploaded'> },
): void {
  const host = new URL(config.blossomUrl).hostname

  app.register(async (blossom) => {
    // Web clients upload from other origins.
    blossom.addHook('onSend', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })
    // The body is read in the handler, to stop at the size limit.
    blossom.removeAllContentTypeParsers()
    blossom.addContentTypeParser('*', (_request, _payload, done) => done(null))

    const preflight = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply
        .code(204)
        .header('access-control-allow-headers', 'Authorization, *')
        .header('access-control-allow-methods', 'GET, HEAD, PUT')
        .header('access-control-max-age', '86400')
        .send()
    blossom.options('/upload', preflight)
    blossom.options('/:blob', preflight)

    blossom.put('/upload', async (request, reply) => {
      const auth = authorizationEvent(request.headers.authorization)
      if (!auth) return refuse(reply, 401, 'missing_auth', 'Sign the upload with a kind 24242 event')
      const invalid = checkUploadAuth(auth, host)
      if (invalid) return refuse(reply, 403, 'invalid_auth', invalid)

      const { maxMessageBytes, maxBlobStorageBytes } = settings.current
      const maxBytes = maxMessageBytes + AUTH_TAG_BYTES
      const tooLarge = () => refuse(reply, 413, 'blob_too_large', `A blob is ${maxBytes} bytes at most`)
      const declared = Number(request.headers['content-length']) || 0
      if (declared > maxBytes) return tooLarge()
      // Checked again once the body is read: a chunked one declares no length.
      const full = async (size: number) => {
        const stored = await repo.countBlobBytes()
        if (stored + size <= maxBlobStorageBytes) return false
        request.log.warn({ stored, size, maxBlobStorageBytes }, 'The blob storage is full')
        return true
      }
      const storageFull = () => refuse(reply, 507, 'blob_storage_full', 'The server holds all the blobs it can for now')
      if (await full(declared)) return storageFull()
      const data = await collectLimited(request.raw, maxBytes)
      if (!data) return tooLarge()
      if (!data.length) return refuse(reply, 400, 'empty_blob', 'The blob is empty')
      if (data.length > declared && (await full(data.length))) return storageFull()

      const sha256 = createHash('sha256').update(data).digest('hex')
      const hashes = auth.tags.filter((tag) => tag[0] === 'x').map((tag) => tag[1])
      if (hashes.length && !hashes.includes(sha256)) {
        return refuse(reply, 403, 'invalid_auth', 'The authorization is for another blob')
      }

      await repo.addBlob(sha256, data, auth.pubkey)
      request.log.info({ sha256, size: data.length }, 'Stored a blob')
      void outbox.blobUploaded(sha256).catch((error) => request.log.error({ error }, 'The outbox could not deliver'))
      return reply.send({
        url: `${config.blossomUrl}/${sha256}`,
        sha256,
        size: data.length,
        type: 'application/octet-stream',
        uploaded: Math.floor(Date.now() / 1000),
      })
    })

    // HEAD is answered from this route too.
    blossom.get('/:blob', async (request: BlobRequest, reply) => {
      const sha256 = BLOB_PATH.exec(request.params.blob)?.[1]
      if (!sha256) return reply.callNotFound()

      const blob = await repo.findBlob(sha256)
      if (!blob) return refuse(reply, 404, 'blob_not_found', 'No such blob')
      return reply.type('application/octet-stream').header('x-content-type-options', 'nosniff').send(blob.data)
    })
  })
}

// BUD-11: a kind 24242 event for an upload, unexpired, and scoped to this
// server when it names servers.
function checkUploadAuth(event: NostrEvent, host: string): string | null {
  const now = Math.floor(Date.now() / 1000)
  if (event.kind !== AUTH_KIND || !verifyEvent(event)) return 'The authorization is not a signed kind 24242 event'
  if (event.created_at > now + MAX_CLOCK_SKEW_SECONDS) return 'The authorization is dated in the future'
  if (!(Number(findTagValue(event.tags, 'expiration')) > now)) return 'The authorization has expired'
  if (findTagValue(event.tags, 't') !== 'upload') return 'The authorization is not for an upload'

  const servers = event.tags.filter((tag) => tag[0] === 'server').map((tag) => normalizeHostname(tag[1] ?? ''))
  if (servers.length && !servers.includes(host)) return 'The authorization is for another server'
  return null
}

// BUD-01 gives the reason in X-Reason.
function refuse(reply: FastifyReply, status: number, error: string, reason: string) {
  return reply.code(status).header('x-reason', reason).send({ error })
}
