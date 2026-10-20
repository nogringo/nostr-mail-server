import addressparser from 'nodemailer/lib/addressparser'
import { unwrapEvent } from 'nostr-tools/nip59'
import type { NostrEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { normalizeRecipient, ownsAddress } from './address.js'
import { EMAIL_KIND, type EmailBody } from './inbound.js'
import { fieldValues } from './mime.js'
import { findTagValue } from './nostr.js'
import { sendsMail } from './records.js'
import type { Domain, DomainRepository } from './types.js'

export const MAX_OUTBOUND_RECIPIENTS = 50
const SHA256 = /^[0-9a-f]{64}$/

// Why a wrap addressed to a domain key is not sent. It is final: sending the
// same wrap again gets the same answer.
export class Refusal extends Error {}

export interface OutboundEmail {
  senderPubkey: string
  mailFrom: string
  recipients: string[]
  body: EmailBody
}

// Nostr Mail core: a client sends mail for legacy recipients as a kind 1301
// rumor gift wrapped to the _smtp key of its own domain, the SMTP envelope in
// `mail-from` and `rcpt-to` tags. unwrapEvent checks that the seal's signer
// wrote the rumor.
export function openOutboundWrap(wrap: NostrEvent, bridgePrivateKey: string): OutboundEmail {
  let rumor: NostrEvent
  try {
    rumor = unwrapEvent(wrap, hexToBytes(bridgePrivateKey)) as NostrEvent
  } catch {
    throw new Refusal('The gift wrap cannot be opened with the domain key')
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
function bodyOf({ content, tags }: NostrEvent): EmailBody {
  const sha256 = findTagValue(tags, 'x')
  if (!sha256) {
    if (!content) throw new Refusal('The email is empty')
    return { mime: content }
  }

  const key = findTagValue(tags, 'decryption-key')
  const nonce = findTagValue(tags, 'decryption-nonce')
  if (!SHA256.test(sha256) || findTagValue(tags, 'encryption-algorithm') !== 'aes-gcm' || !key || !nonce) {
    throw new Refusal('The email points to a blob it gives no way to decrypt')
  }
  return { blob: { sha256, key, nonce } }
}

function isTagList(tags: unknown): tags is string[][] {
  return Array.isArray(tags) && tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
}
