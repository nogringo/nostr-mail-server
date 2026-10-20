import { createHash } from 'node:crypto'
import type { NostrEvent } from 'nostr-tools/pure'
import type { EncryptedBlob } from './blossom.js'
import { type KeySigner, wrapWith } from './signer.js'

export const EMAIL_KIND = 1301
// NIP-44 caps a plaintext at 65535 bytes and NIP-59 encrypts twice, so Nostr
// Mail keeps MIME inline below 32 KB and moves larger messages to Blossom.
export const MAX_INLINE_MIME_BYTES = 32 * 1024
// A bunker gets the rumor inside a NIP-46 request and answers the sealed rumor,
// each encrypted once more and carried by relays that often cap events at 64 KiB.
export const MAX_BUNKER_INLINE_MIME_BYTES = 16 * 1024

// The MIME itself, or the Blossom blob holding it once it is too large.
export type EmailBody = { mime: string } | { blob: Pick<EncryptedBlob, 'sha256' | 'key' | 'nonce'> }

export interface InboundEmail {
  mailFrom: string
  emailId: string
  body: EmailBody
}

// Nostr Mail core: mail received over SMTP is written on the sender's behalf by
// the domain's _smtp key, with the envelope sender in `mail-from`. A complaint
// no domain key is left for is written by the server's own key.
export function wrapInboundEmail(email: InboundEmail, writer: KeySigner, recipientPubkey: string): Promise<NostrEvent> {
  return wrapWith(
    writer,
    {
      kind: EMAIL_KIND,
      tags: [['email-id', email.emailId], ['mail-from', email.mailFrom], ...blobTags(email.body)],
      content: 'mime' in email.body ? email.body.mime : '',
    },
    recipientPubkey,
  )
}

// Nostr Mail large MIME: an empty content and these tags point to the blob.
function blobTags(body: EmailBody): string[][] {
  if (!('blob' in body)) return []

  return [
    ['x', body.blob.sha256],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', body.blob.key],
    ['decryption-nonce', body.blob.nonce],
  ]
}

// Derived from the message, so a delivery the sender retries keeps its id.
export function emailIdOf(message: Buffer): string {
  return createHash('sha256').update(message).digest('hex')
}
