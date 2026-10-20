import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { createWrap } from 'nostr-tools/nip59'
import {
  type EventTemplate,
  finalizeEvent,
  getEventHash,
  getPublicKey,
  type NostrEvent,
  type VerifiedEvent,
  verifyEvent,
} from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'

const SEAL_KIND = 13
const GIFT_WRAP_KIND = 1059
const TWO_DAYS_SECONDS = 2 * 24 * 3600

// What the server does with a key it may not hold: the private key is on the
// server, or in the owner's bunker (NIP-46).
export interface KeySigner {
  pubkey: string
  signEvent(template: EventTemplate): Promise<VerifiedEvent>
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>
}

// The bunker did not answer: what needed it is tried again later.
export class SignerUnavailable extends Error {}

// The bunker answered with an error, or the request cannot reach it: asking again gets the same answer.
export class SignerRefusal extends Error {}

export function localSigner(privateKey: string): KeySigner {
  const secretKey = hexToBytes(privateKey)
  return {
    pubkey: getPublicKey(secretKey),
    signEvent: async (template) => finalizeEvent(template, secretKey),
    nip44Encrypt: async (pubkey, plaintext) => encrypt(plaintext, getConversationKey(secretKey, pubkey)),
    nip44Decrypt: async (pubkey, ciphertext) => decrypt(ciphertext, getConversationKey(secretKey, pubkey)),
  }
}

// NIP-59: the signer writes the rumor and signs the seal, and a one-time key
// signs the wrap.
export async function wrapWith(
  signer: KeySigner,
  template: Pick<EventTemplate, 'kind' | 'tags' | 'content'>,
  recipientPubkey: string,
): Promise<NostrEvent> {
  const unsigned = { ...template, created_at: now(), pubkey: signer.pubkey }
  const rumor = { ...unsigned, id: getEventHash(unsigned) }
  const content = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor))
  const seal = await signer.signEvent({ kind: SEAL_KIND, content, created_at: randomPast(), tags: [] })
  return createWrap(seal, recipientPubkey)
}

// Mirrors unwrapEvent of nostr-tools: the seal is valid and signed by the rumor's author.
export async function unwrapWith(signer: KeySigner, wrap: NostrEvent): Promise<NostrEvent> {
  if (wrap.kind !== GIFT_WRAP_KIND) throw new Error(`Unexpected wrap kind ${wrap.kind}`)

  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content))
  if (seal?.kind !== SEAL_KIND || !verifyEvent(seal)) throw new Error('The seal is not valid')

  const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content))
  if (rumor?.pubkey !== seal.pubkey) throw new Error('The rumor is not written by the signer of the seal')
  return rumor
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

// NIP-59 dates the seal and the wrap up to two days back.
function randomPast(): number {
  return now() - Math.floor(Math.random() * TWO_DAYS_SECONDS)
}
