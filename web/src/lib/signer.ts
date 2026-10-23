import { nip19 } from 'nostr-tools'
import { type BunkerPointer, BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'nostr-tools/nip46'
import * as nip49 from 'nostr-tools/nip49'
import { type EventTemplate, finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'

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

type Session =
  | { method: 'extension' }
  | { method: 'bunker'; clientKey: string; pointer: BunkerPointer; pubkey: string }
  | { method: 'key'; nsec: string }

const SESSION_KEY = 'nostr-mail.session'
// A bunker may wait for the user to approve the request on another device.
const BUNKER_TIMEOUT_MS = 120_000
const NOSTR_CONNECT_RELAYS = ['wss://relay.nmail.li/', 'wss://bucket.coracle.social/']

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
  } catch (error) {
    await bunker.close()
    throw error
  }
  return startBunkerSession(bunker, clientKey)
}

export function nostrConnect(abort: AbortSignal): { uri: string; signedIn: Promise<Signer> } {
  const clientKey = generateSecretKey()
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientKey),
    relays: NOSTR_CONNECT_RELAYS,
    secret: crypto.randomUUID(),
    perms: ['sign_event:27235'],
    name: 'Nostr Mail',
    url: location.origin,
  })
  const signedIn = BunkerSigner.fromURI(clientKey, uri, {}, abort).then(
    (bunker) => startBunkerSession(bunker, clientKey),
    () => {
      throw new Error('nostr_connect_closed')
    },
  )
  return { uri, signedIn }
}

export function isSecretKey(input: string): boolean {
  return /^n(sec|cryptsec)1/.test(input.trim())
}

export function isEncryptedKey(input: string): boolean {
  return nip19.NostrTypeGuard.isNcryptsec(input.trim())
}

export async function signInWithKey(input: string, password: string): Promise<Signer> {
  const key = input.trim()
  if (isEncryptedKey(key)) {
    // scrypt blocks the page: let it paint the busy state first.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return startKeySession(decryptKey(key, password))
  }
  return startKeySession(decodeNsec(key))
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

    if (session.method === 'key') return keySigner(decodeNsec(session.nsec))

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

async function startBunkerSession(bunker: BunkerSigner, clientKey: Uint8Array): Promise<Signer> {
  try {
    const pubkey = await withTimeout(bunker.getPublicKey())
    // The secret only works once: a restored session connects without it.
    save({ method: 'bunker', clientKey: nip19.nsecEncode(clientKey), pointer: { ...bunker.bp, secret: null }, pubkey })
    return bunkerSigner(bunker, pubkey)
  } catch (error) {
    await bunker.close()
    throw error
  }
}

function startKeySession(secretKey: Uint8Array): Signer {
  save({ method: 'key', nsec: nip19.nsecEncode(secretKey) })
  return keySigner(secretKey)
}

function decodeNsec(nsec: string): Uint8Array {
  try {
    const decoded = nip19.decode(nsec)
    if (decoded.type === 'nsec') return decoded.data
  } catch {}
  throw new Error('invalid_secret_key')
}

function decryptKey(ncryptsec: string, password: string): Uint8Array {
  try {
    return nip49.decrypt(ncryptsec, password)
  } catch {
    throw new Error('wrong_password')
  }
}

function keySigner(secretKey: Uint8Array): Signer {
  return {
    pubkey: getPublicKey(secretKey),
    signEvent: async (event) => finalizeEvent(event, secretKey),
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

// A secret key stays in this tab only: closing it signs out.
function save(session: Session): void {
  try {
    const storage = session.method === 'key' ? sessionStorage : localStorage
    storage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {}
}

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(SESSION_KEY)
  } catch {}
}
