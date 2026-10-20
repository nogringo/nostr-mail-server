import { isIP } from 'node:net'
import { decode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'

const HEX_PUBKEY = /^[0-9a-f]{64}$/

export function asNostrEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== 'object') return null

  const event = value as Record<string, unknown>
  if (typeof event.id !== 'string') return null
  if (typeof event.pubkey !== 'string') return null
  if (typeof event.created_at !== 'number') return null
  if (typeof event.kind !== 'number') return null
  if (typeof event.content !== 'string') return null
  if (typeof event.sig !== 'string') return null
  if (!Array.isArray(event.tags) || !event.tags.every(isStringArray)) return null

  return event as unknown as NostrEvent
}

export function findTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) return tag[1]
  }

  return undefined
}

// Reads a pubkey given as 64 hex characters or as an npub, and returns it in hex.
export function parsePubkey(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const key = value.trim().toLowerCase()
  return HEX_PUBKEY.test(key) ? key : decodeNpub(key)
}

export function decodeNpub(value: string): string | null {
  if (!value.startsWith('npub1')) return null

  try {
    const decoded = decode(value)
    return decoded.type === 'npub' && HEX_PUBKEY.test(decoded.data) ? decoded.data : null
  } catch {
    return null
  }
}

export function generateKeyPair(): { pubkey: string; privateKey: string } {
  const secretKey = generateSecretKey()
  return { pubkey: getPublicKey(secretKey), privateKey: Buffer.from(secretKey).toString('hex') }
}

// Relay lists are written by whoever holds a key, so only public wss:// hosts
// are kept: no IP literals, no single-label or localhost names.
export function normalizeRelayUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'wss:' || !host.includes('.') || isIP(host) !== 0 || host.endsWith('.localhost')) return null

  return normalizeURL(url.href)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
