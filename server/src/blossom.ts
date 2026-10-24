import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isPublicHostname } from './domain.js'
import type { KeySigner } from './signer.js'

export const AUTH_KIND = 24242
const AUTH_TTL_SECONDS = 300
const UPLOAD_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3
export const AUTH_TAG_BYTES = 16

export interface EncryptedBlob {
  bytes: Buffer<ArrayBuffer>
  sha256: string
  // Base64, as the decryption-key and decryption-nonce tags carry them.
  key: string
  nonce: string
}

export interface BlobStore {
  // Returns the servers that stored the blob.
  upload(servers: string[], blob: EncryptedBlob, auth: KeySigner): Promise<string[]>
  // The first copy found whose hash matches, or null.
  download(servers: string[], sha256: string, maxBytes: number): Promise<Buffer | null>
}

export function normalizeBlossomUrl(value: string): string | null {
  const url = URL.parse(value.trim())
  if (url?.protocol !== 'https:' || !isPublicHostname(url.hostname)) return null

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

// AES-256-GCM with the 16-byte tag appended to the ciphertext, the layout
// Nostr Mail clients decrypt.
export function encryptBlob(data: Buffer): EncryptedBlob {
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const bytes = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])

  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    key: key.toString('base64'),
    nonce: nonce.toString('base64'),
  }
}

export function decryptBlob(bytes: Buffer, key: string, nonce: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(nonce, 'base64'))
  decipher.setAuthTag(bytes.subarray(-AUTH_TAG_BYTES))
  return Buffer.concat([decipher.update(bytes.subarray(0, -AUTH_TAG_BYTES)), decipher.final()])
}

export const blossom: BlobStore = {
  async upload(servers, blob, auth) {
    const stored = await Promise.all(servers.map((server) => uploadTo(server, blob, auth).catch(() => false)))
    return servers.filter((_, index) => stored[index])
  },

  async download(servers, sha256, maxBytes) {
    for (const server of servers) {
      const bytes = await downloadFrom(server, sha256, maxBytes).catch(() => null)
      if (bytes) return bytes
    }
    return null
  },
}

// BUD-01 retrieval. Servers often redirect to a CDN: only https hops to public
// hosts are followed, since the server lists are written by any key.
async function downloadFrom(server: string, sha256: string, maxBytes: number): Promise<Buffer | null> {
  let url = `${server}/${sha256}`
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      const next = URL.parse(location, url)
      if (next?.protocol !== 'https:' || !isPublicHostname(next.hostname)) return null
      url = next.href
      continue
    }
    if (!response.ok) return null

    const bytes = await readLimited(response, maxBytes)
    return bytes && createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null
  }
  return null
}

export async function readLimited(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) return null
  return collectLimited(response.body, maxBytes)
}

export async function collectLimited(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > maxBytes) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// BUD-02 upload, authorized by a BUD-11 token scoped to the server and the blob.
async function uploadTo(server: string, blob: EncryptedBlob, auth: KeySigner): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const token = await auth.signEvent({
    kind: AUTH_KIND,
    created_at: now,
    content: 'Upload an email',
    tags: [
      ['t', 'upload'],
      ['x', blob.sha256],
      ['server', new URL(server).hostname],
      ['expiration', String(now + AUTH_TTL_SECONDS)],
    ],
  })

  const response = await fetch(`${server}/upload`, {
    method: 'PUT',
    body: blob.bytes,
    headers: {
      authorization: `Nostr ${Buffer.from(JSON.stringify(token)).toString('base64url')}`,
      'content-type': 'application/octet-stream',
      'x-sha-256': blob.sha256,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!response.ok) return false

  const descriptor = (await response.json()) as { sha256?: unknown }
  return descriptor.sha256 === blob.sha256
}
