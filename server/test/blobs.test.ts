import { createHash, randomBytes } from 'node:crypto'
import { npubEncode } from 'nostr-tools/nip19'
import { finalizeEvent } from 'nostr-tools/pure'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { encryptBlob } from '../src/blossom.js'
import type { DeliveryResult, MailTransport } from '../src/delivery.js'
import { registerBlossomRoutes } from '../src/handlers/blossom.js'
import { Outbox } from '../src/outbox.js'
import {
  apiConfig,
  FakeBlobStore,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  outboundWrap,
  sendingDomain,
  settingsStore,
  signer,
} from './helpers.js'

class FakeTransport implements MailTransport {
  readonly sent: string[] = []

  async deliver(_domain: string, _mailFrom: string, recipients: string[], message: Buffer) {
    this.sent.push(message.toString())
    return new Map<string, DeliveryResult>(
      recipients.map((recipient) => [recipient, { status: 'delivered', response: '250 OK' }]),
    )
  }
}

async function setup(maxBlobStorageBytes = 16 * 1024 * 1024) {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const settings = settingsStore(repo, { maxMessageBytes: 64 * 1024, maxBlobStorageBytes })
  const transport = new FakeTransport()
  const logger = { info: () => {}, error: () => {} }
  const outbox = new Outbox(repo, network, new FakeBlobStore(), transport, settings, logger)
  const app = buildApp(repo, apiConfig, new FakeDns(), network, settings)
  registerBlossomRoutes(app, repo, { config: apiConfig, settings, outbox })
  await app.ready()
  return { repo, app, outbox, transport }
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function uploadAuth(tags: string[][], kind = 24242): string {
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({ kind, created_at: now, content: 'Upload an email', tags }, signer().sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

function freshTags(data: Buffer): string[][] {
  return [
    ['t', 'upload'],
    ['x', sha256Of(data)],
    ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
  ]
}

function upload(app: Awaited<ReturnType<typeof setup>>['app'], data: Buffer, authorization?: string) {
  return app.inject({
    method: 'PUT',
    url: '/upload',
    headers: { 'content-type': 'application/octet-stream', ...(authorization ? { authorization } : {}) },
    payload: data,
  })
}

test('a signed upload is stored and served back to any origin', async () => {
  const { repo, app } = await setup()
  const data = randomBytes(2048)
  const sha256 = sha256Of(data)

  const stored = await upload(app, data, uploadAuth(freshTags(data)))

  expect(stored.statusCode).toBe(200)
  expect(stored.json()).toEqual({
    url: `${apiConfig.blossomUrl}/${sha256}`,
    sha256,
    size: 2048,
    type: 'application/octet-stream',
    uploaded: expect.any(Number),
  })
  expect(stored.headers['access-control-allow-origin']).toBe('*')
  for (const url of [`/${sha256}`, `/${sha256}.bin`]) {
    const served = await app.inject({ method: 'GET', url })
    expect(served.statusCode).toBe(200)
    expect(served.rawPayload).toEqual(data)
    expect(served.headers['access-control-allow-origin']).toBe('*')
  }
  const head = await app.inject({ method: 'HEAD', url: `/${sha256}` })
  expect(head.statusCode).toBe(200)
  expect(head.headers['content-length']).toBe('2048')
  expect(repo.blobs.get(sha256)?.data).toEqual(data)
  await app.close()
})

test('an upload takes a fresh kind 24242 event for an upload, to this server, of this blob', async () => {
  const { repo, app } = await setup()
  const data = randomBytes(64)
  const [t, x, expiration] = freshTags(data)
  const past = String(Math.floor(Date.now() / 1000) - 1)

  expect((await upload(app, data)).statusCode).toBe(401)
  for (const authorization of [
    uploadAuth([t, x, expiration], 27235),
    uploadAuth([t, x, ['expiration', past]]),
    uploadAuth([t, x]),
    uploadAuth([['t', 'delete'], x, expiration]),
    uploadAuth([t, x, expiration, ['server', 'cdn.example.com']]),
    uploadAuth([t, ['x', 'f'.repeat(64)], expiration]),
  ]) {
    const refused = await upload(app, data, authorization)
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toEqual({ error: 'invalid_auth' })
    expect(refused.headers['x-reason']).toBeTypeOf('string')
  }
  expect(repo.blobs.size).toBe(0)

  const scoped = await upload(app, data, uploadAuth([t, expiration, ['server', 'Nostr.MX.example.org']]))
  expect(scoped.statusCode).toBe(200)
  await app.close()
})

test('a blob larger than the largest message is refused', async () => {
  const { repo, app } = await setup()
  const data = randomBytes(64 * 1024 + 17)

  const refused = await upload(app, data, uploadAuth(freshTags(data)))

  expect(refused.statusCode).toBe(413)
  expect(refused.json()).toEqual({ error: 'blob_too_large' })
  expect(repo.blobs.size).toBe(0)
  await app.close()
})

test('uploads are refused while the blobs held reach the largest storage, and taken again once some go', async () => {
  const { repo, app } = await setup(100 * 1024)
  const first = randomBytes(60 * 1024)
  const second = randomBytes(60 * 1024)
  expect((await upload(app, first, uploadAuth(freshTags(first)))).statusCode).toBe(200)

  const refused = await upload(app, second, uploadAuth(freshTags(second)))

  expect(refused.statusCode).toBe(507)
  expect(refused.json()).toEqual({ error: 'blob_storage_full' })
  expect(repo.blobs.size).toBe(1)

  await repo.pruneBlobs(new Date(Date.now() + 60_000))
  expect((await upload(app, second, uploadAuth(freshTags(second)))).statusCode).toBe(200)
  await app.close()
})

test('a browser may ask before uploading, and paths that name no blob are not found', async () => {
  const { app } = await setup()

  const preflight = await app.inject({ method: 'OPTIONS', url: '/upload' })
  expect(preflight.statusCode).toBe(204)
  expect(preflight.headers).toMatchObject({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, *',
    'access-control-allow-methods': 'GET, HEAD, PUT',
  })
  const missing = await app.inject({ method: 'GET', url: `/${'a'.repeat(64)}` })
  expect(missing.statusCode).toBe(404)
  expect(missing.json()).toEqual({ error: 'blob_not_found' })
  expect((await app.inject({ method: 'GET', url: '/favicon.ico' })).statusCode).toBe(404)
  await app.close()
})

test('an email waiting for its blob goes out as soon as the blob is uploaded', async () => {
  const { repo, app, outbox, transport } = await setup()
  const domain = await sendingDomain(repo, 'example.com', signer().pubkey)
  const alice = signer()
  const mailFrom = `${npubEncode(alice.pubkey)}@example.com`
  const blob = encryptBlob(Buffer.from(`From: ${mailFrom}\nSubject: Big\n\nA large email\n`))
  const wrap = outboundWrap(alice, domain.bridgePubkey, {
    content: '',
    tags: [
      ['x', blob.sha256],
      ['encryption-algorithm', 'aes-gcm'],
      ['decryption-key', blob.key],
      ['decryption-nonce', blob.nonce],
    ],
  })
  await outbox.receive(wrap, domain.bridgePubkey)
  await outbox.deliverDue()
  expect(transport.sent).toEqual([])

  await upload(app, blob.bytes, uploadAuth(freshTags(blob.bytes)))

  await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
  expect(transport.sent[0]).toContain('A large email')
  await app.close()
})
