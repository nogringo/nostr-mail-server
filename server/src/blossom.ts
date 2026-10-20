import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { finalizeEvent } from 'nostr-tools/pure'
import { isPublicHostname } from './domain.js'

const AUTH_KIND = 24242
const AUTH_TTL_SECONDS = 300
const UPLOAD_TIMEOUT_MS = 60_000

export interface EncryptedBlob {
  bytes: Buffer<ArrayBuffer>
  sha256: string
  // Base64, as the decryption-key and decryption-nonce tags carry them.
  key: string
  nonce: string
}

export interface BlobStore {
  // Returns the servers that stored the blob.
  upload(servers: string[], blob: EncryptedBlob, authKey: Uint8Array): Promise<string[]>
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

export const blossom: BlobStore = {
  async upload(servers, blob, authKey) {
    const stored = await Promise.all(servers.map((server) => uploadTo(server, blob, authKey).catch(() => false)))
    return servers.filter((_, index) => stored[index])
  },
}

// BUD-02 upload, authorized by a BUD-11 token scoped to the server and the blob.
async function uploadTo(server: string, blob: EncryptedBlob, authKey: Uint8Array): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const token = finalizeEvent(
    {
      kind: AUTH_KIND,
      created_at: now,
      content: 'Upload an email',
      tags: [
        ['t', 'upload'],
        ['x', blob.sha256],
        ['server', new URL(server).hostname],
        ['expiration', String(now + AUTH_TTL_SECONDS)],
      ],
    },
    authKey,
  )

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
