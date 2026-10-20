import { nip19 } from 'nostr-tools'
import { type BunkerPointer, BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { type EventTemplate, generateSecretKey, type NostrEvent } from 'nostr-tools/pure'

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<NostrEvent>
    }
  }
}

export interface Signer {
  pubkey: string
  signEvent(event: EventTemplate): Promise<NostrEvent>
  close(): Promise<void>
}

type Session = { method: 'extension' } | { method: 'bunker'; clientKey: string; pointer: BunkerPointer; pubkey: string }

const SESSION_KEY = 'nostr-mail.session'
// A bunker may wait for the user to approve the request on another device.
const BUNKER_TIMEOUT_MS = 120_000

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && window.nostr !== undefined
}

export async function signInWithExtension(): Promise<Signer> {
  const signer = await extensionSigner()
  save({ method: 'extension' })
  return signer
}

export async function signInWithBunker(input: string, onAuthUrl: (url: string) => void): Promise<Signer> {
  const pointer = await parseBunkerInput(input.trim())
  if (!pointer) throw new Error('invalid_bunker')

  const clientKey = generateSecretKey()
  const bunker = BunkerSigner.fromBunker(clientKey, pointer, { onauth: onAuthUrl })
  try {
    await withTimeout(bunker.connect())
    const pubkey = await withTimeout(bunker.getPublicKey())
    // The secret only works once: a restored session connects without it.
    save({ method: 'bunker', clientKey: nip19.nsecEncode(clientKey), pointer: { ...pointer, secret: null }, pubkey })
    return bunkerSigner(bunker, pubkey)
  } catch (error) {
    await bunker.close()
    throw error
  }
}

export async function restoreSession(): Promise<Signer | null> {
  const session = load()
  if (!session) return null

  try {
    if (session.method === 'extension') {
      // Some extensions inject window.nostr after the page scripts run.
      await waitFor(hasExtension, 1000)
      return await extensionSigner()
    }

    const clientKey = nip19.decode(session.clientKey as `nsec1${string}`).data
    return bunkerSigner(BunkerSigner.fromBunker(clientKey, session.pointer), session.pubkey)
  } catch {
    forget()
    return null
  }
}

export async function signOut(signer: Signer): Promise<void> {
  forget()
  await signer.close()
}

async function extensionSigner(): Promise<Signer> {
  const nostr = window.nostr
  if (!nostr) throw new Error('no_extension')

  return {
    pubkey: await nostr.getPublicKey(),
    signEvent: (event) => nostr.signEvent(event),
    close: async () => {},
  }
}

function bunkerSigner(bunker: BunkerSigner, pubkey: string): Signer {
  return {
    pubkey,
    signEvent: (event) => withTimeout(bunker.signEvent(event)),
    close: () => bunker.close(),
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bunker_timeout')), BUNKER_TIMEOUT_MS)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function save(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {}
}

function load(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function forget(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {}
}
