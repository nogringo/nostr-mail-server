import { createDecipheriv, createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type NostrEvent, verifyEvent } from 'nostr-tools/pure'
import { afterEach, expect, test } from 'vitest'
import { blossom, decryptBlob, encryptBlob, normalizeBlossomUrl } from '../src/blossom.js'
import { keySigner, signer } from './helpers.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

interface Upload {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

// A Blossom server that records each request and answers with `respond`.
async function blossomServer(respond: (upload: Upload, response: ServerResponse) => void) {
  const uploads: Upload[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const upload = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks),
    }
    uploads.push(upload)
    respond(upload, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, uploads }
}

function descriptor(
  upload: Upload,
  response: ServerResponse,
  sha256 = createHash('sha256').update(upload.body).digest('hex'),
) {
  response.writeHead(201, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ sha256, size: upload.body.length, type: 'application/octet-stream', uploaded: 1 }))
}

test('encryptBlob produces an AES-256-GCM blob a client decrypts with the tags', () => {
  const mime = Buffer.from('Subject: Hi\r\n\r\nHello\r\n')

  const blob = encryptBlob(mime)

  expect(blob.sha256).toBe(createHash('sha256').update(blob.bytes).digest('hex'))
  expect(Buffer.from(blob.key, 'base64')).toHaveLength(32)
  expect(Buffer.from(blob.nonce, 'base64')).toHaveLength(12)
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(blob.key, 'base64'), Buffer.from(blob.nonce, 'base64'))
  decipher.setAuthTag(blob.bytes.subarray(-16))
  expect(Buffer.concat([decipher.update(blob.bytes.subarray(0, -16)), decipher.final()])).toEqual(mime)
})

test('normalizeBlossomUrl keeps public https:// servers without a trailing slash', () => {
  expect(normalizeBlossomUrl(' https://Blossom.Example.com/ ')).toBe('https://blossom.example.com')
  expect(normalizeBlossomUrl('https://cdn.example.org/blossom/')).toBe('https://cdn.example.org/blossom')
  for (const url of ['http://blossom.example.com', 'https://localhost', 'https://10.0.0.1', 'https://[::1]', 'nope']) {
    expect(normalizeBlossomUrl(url), url).toBeNull()
  }
})

test('upload PUTs the blob with a BUD-11 token scoped to the server and the blob', async () => {
  const server = await blossomServer(descriptor)
  const uploader = signer()
  const blob = encryptBlob(Buffer.from('a large email'))

  const stored = await blossom.upload([server.url], blob, keySigner(uploader))

  expect(stored).toEqual([server.url])
  const [upload] = server.uploads
  expect(upload.method).toBe('PUT')
  expect(upload.url).toBe('/upload')
  expect(upload.body).toEqual(blob.bytes)
  expect(upload.headers['x-sha-256']).toBe(blob.sha256)
  expect(upload.headers['content-type']).toBe('application/octet-stream')

  const [scheme, encoded] = (upload.headers.authorization ?? '').split(' ')
  const token: NostrEvent = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  expect(scheme).toBe('Nostr')
  expect(verifyEvent(token)).toBe(true)
  expect(token.kind).toBe(24242)
  expect(token.pubkey).toBe(uploader.pubkey)
  const tags = Object.fromEntries(token.tags.map(([name, value]) => [name, value]))
  expect(tags).toMatchObject({ t: 'upload', x: blob.sha256, server: '127.0.0.1' })
  expect(Number(tags.expiration)).toBeGreaterThan(Date.now() / 1000)
})

test('upload returns only the servers that stored the blob', async () => {
  const good = await blossomServer(descriptor)
  const refusing = await blossomServer((_, response) => {
    response.writeHead(401, { 'x-reason': 'unknown pubkey' })
    response.end()
  })
  const lying = await blossomServer((upload, response) => descriptor(upload, response, 'f'.repeat(64)))
  const closed = await blossomServer(descriptor)
  await new Promise((resolve) => servers.pop()?.close(resolve))

  const stored = await blossom.upload(
    [refusing.url, good.url, lying.url, closed.url],
    encryptBlob(Buffer.from('mail')),
    keySigner(signer()),
  )

  expect(stored).toEqual([good.url])
})

test('decryptBlob reads what encryptBlob wrote, and refuses a blob that was changed', () => {
  const mime = Buffer.from('Subject: Hi\r\n\r\nHello\r\n')
  const blob = encryptBlob(mime)

  expect(decryptBlob(blob.bytes, blob.key, blob.nonce)).toEqual(mime)
  const tampered = Buffer.from(blob.bytes)
  tampered[0] ^= 1
  expect(() => decryptBlob(tampered, blob.key, blob.nonce)).toThrow()
})

test('download returns the first copy whose hash matches', async () => {
  const blob = encryptBlob(Buffer.from('Subject: Hi\r\n\r\nHello\r\n'))
  const missing = await blossomServer((_, response) => response.writeHead(404).end())
  const wrong = await blossomServer((_, response) => response.writeHead(200).end('not the blob'))
  const holder = await blossomServer((_, response) => response.writeHead(200).end(blob.bytes))

  const bytes = await blossom.download([missing.url, wrong.url, holder.url], blob.sha256, 1024)

  expect(bytes).toEqual(blob.bytes)
  expect(holder.uploads.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET /${blob.sha256}`])
})

test('download gives up on a blob above the limit or behind a redirect to a private host', async () => {
  const blob = encryptBlob(Buffer.alloc(2048))
  const holder = await blossomServer((_, response) => response.writeHead(200).end(blob.bytes))
  const redirecting = await blossomServer((_, response) =>
    response.writeHead(302, { location: `${holder.url}/${blob.sha256}` }).end(),
  )

  expect(await blossom.download([holder.url], blob.sha256, 1024)).toBeNull()
  expect(await blossom.download([redirecting.url], blob.sha256, 4096)).toBeNull()
  expect(holder.uploads).toHaveLength(1)
})
