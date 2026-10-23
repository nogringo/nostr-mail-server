import { normalizeDomain } from './domain.js'
import { decodeNpub } from './nostr.js'
import type { Address, Domain, DomainRepository } from './types.js'

// NIP-05 names allow a-z0-9-_. and an unquoted email local part is
// dot-separated atoms of at most 64 characters.
const LOCAL_PART = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/
const DOT_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i

// Where clients find the key to wrap the mail they send from a domain to.
export const SMTP_LOCAL_PART = '_smtp'
// RFC 2142: where complaints about a domain go.
export const ABUSE_LOCAL_PART = 'abuse'

// The RFC 2142 mailboxes and the names that speak for a domain: on a shared domain only its owner gives them.
const OWNER_LOCAL_PARTS = new Set([
  'info',
  'marketing',
  'sales',
  'support',
  ABUSE_LOCAL_PART,
  'noc',
  'security',
  'postmaster',
  'hostmaster',
  'usenet',
  'news',
  'webmaster',
  'www',
  'uucp',
  'ftp',
  'admin',
  'administrator',
  'root',
  'mailer-daemon',
  'noreply',
  'no-reply',
])

export function normalizeLocalPart(value: string): string | null {
  const localPart = value.trim().toLowerCase()
  return localPart.length <= 64 && LOCAL_PART.test(localPart) ? localPart : null
}

// Any unquoted local part, like alice+shop, which only a catch-all creates.
export function normalizeDotAtom(value: string): string | null {
  const localPart = value.trim().toLowerCase()
  return localPart.length <= 64 && DOT_ATOM.test(localPart) ? localPart : null
}

// npub local parts resolve to their own pubkey on every verified domain.
export function isReservedLocalPart(localPart: string): boolean {
  return localPart === SMTP_LOCAL_PART || localPart.startsWith('npub1')
}

export function isOwnerLocalPart(localPart: string): boolean {
  return OWNER_LOCAL_PARTS.has(localPart)
}

// alice+shop is an address of its own, not alice with a tag.
export function parseEmailAddress(value: string): { localPart: string; domain: string } | null {
  const at = value.lastIndexOf('@')
  if (at <= 0) return null

  const localPart = normalizeDotAtom(value.slice(0, at))
  const domain = normalizeDomain(value.slice(at + 1))
  return localPart && domain ? { localPart, domain } : null
}

type Mailbox = Pick<Address, 'pubkey' | 'enabled'>

// The pubkey behind an address of a verified domain: an npub local part is its
// own pubkey, anything else has to be declared.
export async function findMailbox(repo: DomainRepository, domain: string, localPart: string): Promise<Mailbox | null> {
  const npubPubkey = decodeNpub(localPart)
  return npubPubkey ? { pubkey: npubPubkey, enabled: true } : await repo.findAddress(domain, localPart)
}

// A catch-all domain creates the addresses it does not know for its owner, private, except the deleted
// ones. A shared domain catches nothing: its names are left for the keys that create them.
export async function catchAddress(repo: DomainRepository, domain: Domain, localPart: string): Promise<Mailbox | null> {
  if (!domain.catchAll || domain.shared || isReservedLocalPart(localPart)) return null
  return await repo.createCatchAllAddress(domain, localPart)
}

// A sender writes from the addresses of the domain that resolve to its key, private and disabled ones included.
export async function ownsAddress(
  repo: DomainRepository,
  domain: string,
  address: string,
  pubkey: string,
): Promise<boolean> {
  const parsed = parseEmailAddress(address)
  return parsed?.domain === domain && (await findMailbox(repo, domain, parsed.localPart))?.pubkey === pubkey
}

// An address mail is relayed to: a dot-atom local part (RFC 5322 3.2.3) kept as
// written, and the domain in lowercase ASCII. Quoted local parts are not relayed.
export function normalizeRecipient(value: string): string | null {
  const at = value.lastIndexOf('@')
  const localPart = value.slice(0, at)
  const domain = normalizeDomain(value.slice(at + 1))
  if (at <= 0 || localPart.length > 64 || !DOT_ATOM.test(localPart) || !domain) return null

  return `${localPart}@${domain}`
}
