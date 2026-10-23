import { readLimited } from './blossom.js'
import type { Nip05Lookup } from './types.js'

const LOOKUP_TIMEOUT_MS = 5000
const MAX_NOSTR_JSON_BYTES = 1024 * 1024

export const fetchNip05: Nip05Lookup = async (domain, name) => {
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location) {
    return { redirect: URL.parse(location, url)?.href ?? location }
  }
  if (!response.ok) return { pubkey: null }

  const body = await readLimited(response, MAX_NOSTR_JSON_BYTES)
  const pubkey = body && parseJson(body.toString('utf8'))?.names?.[name]
  return { pubkey: typeof pubkey === 'string' ? pubkey : null }
}

function parseJson(text: string): { names?: Record<string, unknown> } | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
