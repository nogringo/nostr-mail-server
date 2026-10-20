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
