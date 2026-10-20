import { createHash } from 'node:crypto'
import { wrapEvent } from 'nostr-tools/nip59'
import type { NostrEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'

export const EMAIL_KIND = 1301
// NIP-44 caps a plaintext at 65535 bytes and NIP-59 encrypts twice, so Nostr
// Mail keeps MIME inline below 32 KB.
export const MAX_INLINE_MIME_BYTES = 32 * 1024

export interface InboundEmail {
  mime: string
  mailFrom: string
  emailId: string
}

// Nostr Mail core: mail received over SMTP is written on the sender's behalf by
// the domain's _smtp key, with the envelope sender in `mail-from`.
export function wrapInboundEmail(email: InboundEmail, bridgePrivateKey: string, recipientPubkey: string): NostrEvent {
  return wrapEvent(
    {
      kind: EMAIL_KIND,
      tags: [
        ['email-id', email.emailId],
        ['mail-from', email.mailFrom],
      ],
      content: email.mime,
    },
    hexToBytes(bridgePrivateKey),
    recipientPubkey,
  )
}

// Derived from the message, so a delivery the sender retries keeps its id.
export function emailIdOf(message: Buffer): string {
  return createHash('sha256').update(message).digest('hex')
}
