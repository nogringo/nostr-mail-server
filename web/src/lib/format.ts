import { nip19 } from 'nostr-tools'

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}...${npub.slice(-4)}`
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
] as const

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }

  return 'just now'
}
