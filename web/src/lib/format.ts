import { nip19 } from 'nostr-tools'
import type { Locale } from '../i18n'

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}...${npub.slice(-4)}`
}

const UNITS = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
] as const

const JUST_NOW: Record<Locale, string> = { en: 'just now', fr: "à l'instant" }

export function timeAgo(iso: string, locale: Locale, now = Date.now()): string {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }

  return JUST_NOW[locale]
}

export function byteSize(bytes: number, locale: Locale): string {
  const mebibyte = 1024 * 1024
  const format = (unit: 'kilobyte' | 'megabyte', value: number, digits: number) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: digits }).format(value)
  return bytes < mebibyte
    ? format('kilobyte', Math.max(1, Math.round(bytes / 1024)), 0)
    : format('megabyte', bytes / mebibyte, 1)
}
