import { normalizeDomain } from './domain.js'
import { decodeNpub } from './nostr.js'
import type { DomainRepository } from './types.js'

// NIP-05 names allow a-z0-9-_. and an unquoted email local part is
// dot-separated atoms of at most 64 characters.
const LOCAL_PART = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/

// Where clients find the key to wrap the mail they send from a domain to.
export const SMTP_LOCAL_PART = '_smtp'

export function normalizeLocalPart(value: string): string | null {
  const localPart = value.trim().toLowerCase()
  return localPart.length <= 64 && LOCAL_PART.test(localPart) ? localPart : null
}

// npub local parts resolve to their own pubkey on every verified domain.
export function isReservedLocalPart(localPart: string): boolean {
  return localPart === SMTP_LOCAL_PART || localPart.startsWith('npub1')
}

export function parseEmailAddress(value: string): { localPart: string; domain: string } | null {
  const at = value.lastIndexOf('@')
  if (at <= 0) return null

  const localPart = normalizeLocalPart(value.slice(0, at))
  const domain = normalizeDomain(value.slice(at + 1))
  return localPart && domain ? { localPart, domain } : null
}

// The pubkey behind an address of a verified domain: an npub local part is its
// own pubkey, anything else has to be declared.
export async function findAddressPubkey(
  repo: DomainRepository,
  domain: string,
  localPart: string,
): Promise<string | null> {
  return decodeNpub(localPart) ?? (await repo.findAddress(domain, localPart))?.pubkey ?? null
}
