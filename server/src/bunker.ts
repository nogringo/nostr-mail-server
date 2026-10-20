import { type BunkerPointer, BunkerSigner } from 'nostr-tools/nip46'
import { type EventTemplate, generateSecretKey, type VerifiedEvent, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { normalizeRelayUrl } from './nostr.js'
import { type KeySigner, localSigner, SignerRefusal, SignerUnavailable } from './signer.js'
import type { BridgeKey, BunkerKey } from './types.js'

const HEX_PUBKEY = /^[0-9a-f]{64}$/
const MAX_RELAYS = 4
// The owner may have to approve the connection in their bunker.
const CONNECT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
const IDLE_MS = 15 * 60_000
// NIP-46 encrypts each request with NIP-44, which pads it, and base64 grows it
// by a third: past 40 KiB the event passes 64 KiB, which relays commonly refuse.
const MAX_REQUEST_BYTES = 40 * 1024
// Room for the id BunkerSigner gives a request.
const REQUEST_ID = 'x'.repeat(24)
const PROBE = 'nostr-mail'

// What the server asks a bunker for: seals (13), NIP-42 (22242), Blossom
// uploads (24242) and the lists of the domain key.
export const BUNKER_PERMISSIONS = [
  'nip44_encrypt',
  'nip44_decrypt',
  ...[13, 22242, 24242, 10002, 10050, 10063].map((kind) => `sign_event:${kind}`),
].join(',')

// What the server uses of a BunkerSigner of nostr-tools.
export type BunkerConnection = Pick<BunkerSigner, 'sendRequest' | 'close'>

export type OpenBunker = (
  clientKey: Uint8Array,
  pointer: BunkerPointer,
  onauth: (url: string) => void,
) => BunkerConnection

export type BunkerErrorCode = 'bunker_timeout' | 'bunker_refused' | 'bunker_auth_url'

export class BunkerError extends Error {
  constructor(readonly code: BunkerErrorCode) {
    super(code)
  }
}

interface SignersOptions {
  open?: OpenBunker
  timeoutMs?: number
  connectTimeoutMs?: number
  logger?: { info(details: object, message: string): void }
}

const openNostrBunker: OpenBunker = (clientKey, pointer, onauth) =>
  BunkerSigner.fromBunker(clientKey, pointer, { onauth })

// Reads a bunker:// URL with at least one public wss:// relay.
export function parseBunkerUrl(value: unknown): BunkerPointer | null {
  if (typeof value !== 'string') return null

  const url = URL.parse(value.trim())
  if (url?.protocol !== 'bunker:' || !HEX_PUBKEY.test(url.hostname)) return null

  const relays = [...new Set(url.searchParams.getAll('relay').map(normalizeRelayUrl))].filter((relay) => relay !== null)
  if (!relays.length) return null

  return { pubkey: url.hostname, relays: relays.slice(0, MAX_RELAYS), secret: url.searchParams.get('secret') }
}

// The signers of the domain keys: the same one while a key stays where it is,
// so that each bunker gets a single connection.
export class DomainSigners {
  private readonly signers = new Map<string, { holder: string; signer: KeySigner | BunkerKeySigner }>()
  private readonly open: OpenBunker
  private readonly timeoutMs: number
  private readonly connectTimeoutMs: number

  constructor(private readonly options: SignersOptions = {}) {
    this.open = options.open ?? openNostrBunker
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  }

  forDomain(domain: BridgeKey): KeySigner {
    const holder = domain.bridgeBunker ? JSON.stringify(domain.bridgeBunker) : domain.bridgePrivateKey
    if (holder === null) throw new Error(`No key is held for ${domain.bridgePubkey}`)

    const known = this.signers.get(domain.bridgePubkey)
    if (known?.holder === holder) return known.signer
    if (known?.signer instanceof BunkerKeySigner) void known.signer.close()

    const signer = domain.bridgeBunker
      ? new BunkerKeySigner(domain.bridgePubkey, domain.bridgeBunker, this.open, this.timeoutMs, (url) =>
          this.options.logger?.info(
            { pubkey: domain.bridgePubkey, url },
            'A bunker asks its owner to approve a request',
          ),
        )
      : localSigner(holder)
    this.signers.set(domain.bridgePubkey, { holder, signer })
    return signer
  }

  // Connects to the bunker with a new client key, asks for what the server
  // needs, and checks NIP-44 both ways: the mail relies on it.
  async connect(pointer: BunkerPointer): Promise<{ pubkey: string; bunker: BunkerKey }> {
    const clientKey = generateSecretKey()
    // An approval in a browser is something only the owner can do: this server cannot wait for it.
    let approve = () => {}
    const approval = new Promise<never>((_, reject) => {
      approve = () => reject(new BunkerError('bunker_auth_url'))
    })
    approval.catch(() => {})
    const connection = this.open(clientKey, pointer, () => approve())
    const step = (method: string, params: string[]) =>
      Promise.race([ask(connection, method, params, this.connectTimeoutMs), approval])

    try {
      await step('connect', [pointer.pubkey, pointer.secret ?? '', BUNKER_PERMISSIONS])
      const pubkey = await step('get_public_key', [])
      if (!HEX_PUBKEY.test(pubkey)) throw new SignerRefusal('The bunker answered no pubkey')
      const probe = await step('nip44_encrypt', [pubkey, PROBE])
      if ((await step('nip44_decrypt', [pubkey, probe])) !== PROBE)
        throw new SignerRefusal('NIP-44 does not round trip')

      return {
        pubkey,
        bunker: { signerPubkey: pointer.pubkey, relays: pointer.relays, clientKey: bytesToHex(clientKey) },
      }
    } catch (error) {
      if (error instanceof SignerUnavailable) throw new BunkerError('bunker_timeout')
      if (error instanceof SignerRefusal) throw new BunkerError('bunker_refused')
      throw error
    } finally {
      await connection.close()
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.signers.values()].map(({ signer }) => (signer instanceof BunkerKeySigner ? signer.close() : null)),
    )
    this.signers.clear()
  }
}

// Asks the owner's bunker over a connection opened on demand, and dropped once
// the bunker stops answering or nobody asked anything for a while.
class BunkerKeySigner implements KeySigner {
  private connection: BunkerConnection | null = null
  private idleTimer: NodeJS.Timeout | undefined

  constructor(
    readonly pubkey: string,
    private readonly bunker: BunkerKey,
    private readonly open: OpenBunker,
    private readonly timeoutMs: number,
    private readonly onauth: (url: string) => void,
  ) {}

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const signed = parse(await this.request('sign_event', [JSON.stringify(template)]))
    if (!verifyEvent(signed) || signed.pubkey !== this.pubkey)
      throw new SignerRefusal('The bunker signed with another key')
    return signed
  }

  nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
    return this.request('nip44_encrypt', [pubkey, plaintext])
  }

  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    return this.request('nip44_decrypt', [pubkey, ciphertext])
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer)
    const connection = this.connection
    this.connection = null
    await connection?.close()
  }

  private async request(method: string, params: string[]): Promise<string> {
    if (Buffer.byteLength(JSON.stringify({ id: REQUEST_ID, method, params })) > MAX_REQUEST_BYTES) {
      throw new SignerRefusal(`The ${method} request is too large for NIP-46`)
    }

    this.connection ??= this.open(
      hexToBytes(this.bunker.clientKey),
      { pubkey: this.bunker.signerPubkey, relays: this.bunker.relays, secret: null },
      this.onauth,
    )
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS).unref()

    try {
      return await ask(this.connection, method, params, this.timeoutMs)
    } catch (error) {
      // Its subscription may be gone with a dropped connection: the next request opens a new one.
      if (error instanceof SignerUnavailable) await this.close()
      throw error
    }
  }
}

// BunkerSigner rejects with the bunker's error as a plain string.
async function ask(connection: BunkerConnection, method: string, params: string[], timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SignerUnavailable(`The bunker did not answer ${method} in time`)), timeoutMs)
  })

  try {
    return await Promise.race([connection.sendRequest(method, params), timeout])
  } catch (error) {
    if (typeof error === 'string') throw new SignerRefusal(`The bunker refused ${method}: ${error}`)
    if (error instanceof SignerUnavailable) throw error
    // No relay of the bunker took the request.
    throw new SignerUnavailable(`The bunker could not be asked ${method}: ${(error as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

function parse(answer: string): VerifiedEvent {
  try {
    return JSON.parse(answer)
  } catch {
    throw new SignerRefusal('The bunker answered no event')
  }
}
