import { nip19 } from 'nostr-tools'

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}...${npub.slice(-4)}`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
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

const kilobytes = new Intl.NumberFormat('en', { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
const megabytes = new Intl.NumberFormat('en', { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })

export function byteSize(bytes: number): string {
  const mebibyte = 1024 * 1024
  return bytes < mebibyte ? kilobytes.format(Math.max(1, Math.round(bytes / 1024))) : megabytes.format(bytes / mebibyte)
}
