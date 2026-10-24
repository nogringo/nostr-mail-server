import addressparser from 'nodemailer/lib/addressparser'
import type { NostrEvent } from 'nostr-tools/pure'
import { normalizeRecipient, ownsAddress } from './address.js'
import type { EncryptedBlob } from './blossom.js'
import { EMAIL_KIND } from './inbound.js'
import { fieldValues } from './mime.js'
import { findTagValue } from './nostr.js'
import { sendsMail } from './records.js'
import { type KeySigner, SignerRefusal, SignerUnavailable, unwrapWith } from './signer.js'
import type { Domain, DomainRepository } from './types.js'

export const MAX_OUTBOUND_RECIPIENTS = 50
const SHA256 = /^[0-9a-f]{64}$/

// Why a wrap addressed to a domain key is not sent. It is final: sending the
// same wrap again gets the same answer.
export class Refusal extends Error {}

// The MIME inline, or in a blob that a public email may leave in the clear.
export type OutboundBody =
  | { mime: string }
  | { blob: Pick<EncryptedBlob, 'sha256'> | Pick<EncryptedBlob, 'sha256' | 'key' | 'nonce'> }

export interface OutboundEmail {
  senderPubkey: string
  mailFrom: string
  recipients: string[]
  body: OutboundBody
}

// Nostr Mail core: a client sends mail for legacy recipients as a kind 1301
// rumor gift wrapped to the _smtp key of its own domain, the SMTP envelope in
// `mail-from` and `rcpt-to` tags. unwrapWith checks that the seal's signer
// wrote the rumor. A bunker that does not answer now may answer later.
export async function openOutboundWrap(wrap: NostrEvent, domainKey: KeySigner): Promise<OutboundEmail> {
  let rumor: NostrEvent
  try {
    rumor = await unwrapWith(domainKey, wrap)
  } catch (error) {
    if (error instanceof SignerUnavailable) throw error
    throw new Refusal(
      error instanceof SignerRefusal ? error.message : 'The gift wrap cannot be opened with the domain key',
    )
  }
  if (rumor.kind !== EMAIL_KIND || typeof rumor.content !== 'string' || !isTagList(rumor.tags)) {
    throw new Refusal('The gift wrap does not hold an email')
  }

  const mailFrom = findTagValue(rumor.tags, 'mail-from')
  if (!mailFrom) throw new Refusal('The email has no mail-from tag')

  return { senderPubkey: rumor.pubkey, mailFrom, recipients: recipientsOf(rumor.tags), body: bodyOf(rumor) }
}

// The domain relays for the addresses it serves, once SPF and DKIM let it send.
export async function checkSender(repo: DomainRepository, domain: Domain, email: OutboundEmail): Promise<void> {
  if (!sendsMail(domain))
    throw new Refusal(`${domain.domain} does not send mail until its SPF and DKIM records are found`)
  if (!(await ownsAddress(repo, domain.domain, email.mailFrom, email.senderPubkey))) {
    throw new Refusal(`${email.mailFrom} is not an address of the sender`)
  }
}

// DMARC aligns the From address with the domain's DKIM signature, so it has to
// be the sender's own on the domain too.
export async function checkAuthor(
  repo: DomainRepository,
  domain: Domain,
  senderPubkey: string,
  mime: Buffer,
): Promise<void> {
  const fields = fieldValues(mime, 'from')
  const addresses = fields.length === 1 ? addressparser(fields[0], { flatten: true }) : []
  if (addresses.length !== 1) throw new Refusal('The email needs a From field with one address')

  const [{ address }] = addresses
  if (!(await ownsAddress(repo, domain.domain, address, senderPubkey))) {
    throw new Refusal(`From ${address} is not an address of the sender`)
  }
}

function recipientsOf(tags: string[][]): string[] {
  const recipients = new Map<string, string>()
  for (const [name, value] of tags) {
    if (name !== 'rcpt-to') continue

    const recipient = normalizeRecipient(value ?? '')
    if (!recipient) throw new Refusal(`${value} is not an address mail can be relayed to`)
    recipients.set(recipient.toLowerCase(), recipient)
  }

  if (!recipients.size) throw new Refusal('The email has no rcpt-to tag')
  if (recipients.size > MAX_OUTBOUND_RECIPIENTS) {
    throw new Refusal(`An email is relayed to at most ${MAX_OUTBOUND_RECIPIENTS} recipients`)
  }
  return [...recipients.values()]
}

// Nostr Mail large MIME: an empty content and tags pointing to the blob.
function bodyOf({ content, tags }: NostrEvent): OutboundBody {
  const sha256 = findTagValue(tags, 'x')
  if (!sha256) {
    if (!content) throw new Refusal('The email is empty')
    return { mime: content }
  }
  if (!SHA256.test(sha256)) throw new Refusal('The email points to a blob by an invalid hash')

  const algorithm = findTagValue(tags, 'encryption-algorithm')
  const key = findTagValue(tags, 'decryption-key')
  const nonce = findTagValue(tags, 'decryption-nonce')
  if (algorithm === undefined && key === undefined && nonce === undefined) return { blob: { sha256 } }
  if (algorithm !== 'aes-gcm' || !key || !nonce) {
    throw new Refusal('The email points to a blob it gives no way to decrypt')
  }
  return { blob: { sha256, key, nonce } }
}

function isTagList(tags: unknown): tags is string[][] {
  return Array.isArray(tags) && tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
}
