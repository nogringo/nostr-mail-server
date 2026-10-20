import { isIPv4, isIPv6, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { DNSResolver } from 'mailauth'
import type { Filter } from 'nostr-tools/filter'
import { npubEncode } from 'nostr-tools/nip19'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { wrapEvent } from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import type { buildApp } from '../src/app.js'
import type { BlobStore, EncryptedBlob } from '../src/blossom.js'
import { generateDkimKeyPair } from '../src/dkim.js'
import { NIP98_KIND } from '../src/nip98.js'
import { generateKeyPair } from '../src/nostr.js'
import type { Inbox, RelayNetwork, Subscription } from '../src/relays.js'
import { readTls, type TlsCredentials } from '../src/tls.js'
import type {
  AbuseReport,
  Address,
  ApiConfig,
  DnsLookup,
  Domain,
  DomainChecks,
  DomainConfig,
  DomainRepository,
  DomainSummary,
  KeyPair,
  MxRecord,
  NewAbuseReport,
  NewAddress,
  NewDomain,
  NewOutboundMessage,
  OutboundMessage,
  RecipientOutcome,
  Suspension,
  TlsFiles,
} from '../src/types.js'

export const API_HOST = 'app.example.org'

export const domainConfig: DomainConfig = {
  mxHost: 'mx.example.org',
  spfInclude: '_spf.example.org',
  publicIpv4: '192.0.2.10',
  dkimSelector: 'nostrmail',
  indexerRelays: ['wss://indexer.example.org/'],
  domainRelays: ['wss://relay.example.org/'],
  blossomServers: ['https://blossom.example.org'],
}

export const apiConfig: ApiConfig = { ...domainConfig, adminPubkeys: [] }

export interface StoredRecipient {
  status: RecipientOutcome['status']
  attempts: number
  nextAttemptAt: Date
  response: string | null
}

export interface StoredOutboundMessage {
  bridgePubkey: string
  wrap: NostrEvent | null
  refusal: string | null
  receivedAt: string
  recipients: Map<string, StoredRecipient>
}

export class MemoryDomainRepository implements DomainRepository {
  readonly domains = new Map<string, Domain>()
  readonly addresses = new Map<string, Address>()
  readonly outbound = new Map<string, StoredOutboundMessage>()
  readonly suspensions = new Map<string, Suspension>()
  readonly servedDomains = new Set<string>()
  serverKey: KeyPair | null = null
  readonly abuseReports: { report: AbuseReport; emailId: string; message: Buffer }[] = []
  fail = false

  async findDomain(domain: string, pubkey: string): Promise<Domain | null> {
    this.assertAvailable()
    return this.domains.get(key(domain, pubkey)) ?? null
  }

  async findVerifiedDomain(domain: string): Promise<Domain | null> {
    this.assertAvailable()
    return [...this.domains.values()].find((claim) => claim.domain === domain && this.inService(claim)) ?? null
  }

  async findVerifiedDomainByBridgePubkey(bridgePubkey: string): Promise<Domain | null> {
    this.assertAvailable()
    return (
      [...this.domains.values()].find((claim) => claim.bridgePubkey === bridgePubkey && this.inService(claim)) ?? null
    )
  }

  async findOwnedDomain(domain: string): Promise<Domain | null> {
    this.assertAvailable()
    return [...this.domains.values()].find((claim) => claim.domain === domain && claim.verifiedAt !== null) ?? null
  }

  async hasServedDomain(domain: string): Promise<boolean> {
    this.assertAvailable()
    return this.servedDomains.has(domain)
  }

  async listVerifiedDomains(): Promise<Domain[]> {
    this.assertAvailable()
    return [...this.domains.values()].filter((claim) => this.inService(claim))
  }

  async listDomains(pubkey: string): Promise<Domain[]> {
    this.assertAvailable()
    return [...this.domains.values()]
      .filter((domain) => domain.pubkey === pubkey)
      .sort((left, right) => left.domain.localeCompare(right.domain))
  }

  async listAllDomains(): Promise<DomainSummary[]> {
    this.assertAvailable()
    return [...this.domains.values()]
      .map((domain) => ({
        ...domain,
        addressCount: [...this.addresses.values()].filter(
          (address) => address.domain === domain.domain && address.ownerPubkey === domain.pubkey,
        ).length,
      }))
      .sort((left, right) => left.domain.localeCompare(right.domain) || left.createdAt.localeCompare(right.createdAt))
  }

  async createDomain(input: NewDomain): Promise<Domain> {
    this.assertAvailable()
    const existing = this.domains.get(key(input.domain, input.pubkey))
    if (existing) return existing

    const domain: Domain = {
      ...input,
      checks: null,
      checkedAt: null,
      verifiedAt: null,
      createdAt: new Date().toISOString(),
    }
    this.domains.set(key(input.domain, input.pubkey), domain)
    return domain
  }

  async recordChecks(domain: string, pubkey: string, checks: DomainChecks, verified: boolean): Promise<Domain | null> {
    this.assertAvailable()
    const current = this.domains.get(key(domain, pubkey))
    if (!current) return null

    if (verified) {
      for (const claim of this.domains.values()) {
        if (claim.domain === domain && claim.pubkey !== pubkey) this.dropClaim(domain, claim.pubkey)
      }
    }

    const now = new Date().toISOString()
    const next = {
      ...current,
      checks,
      checkedAt: now,
      verifiedAt: verified ? (current.verifiedAt ?? now) : current.verifiedAt,
    }
    this.domains.set(key(domain, pubkey), next)
    if (verified) this.servedDomains.add(domain)
    return next
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.dropClaim(domain, pubkey)
  }

  async listSuspensions(): Promise<Suspension[]> {
    this.assertAvailable()
    return [...this.suspensions.values()].sort((left, right) => left.domain.localeCompare(right.domain))
  }

  async findSuspension(domain: string): Promise<Suspension | null> {
    this.assertAvailable()
    return this.suspensions.get(domain) ?? null
  }

  async suspendDomain(domain: string): Promise<Suspension> {
    this.assertAvailable()
    const suspension = this.suspensions.get(domain) ?? { domain, suspendedAt: new Date().toISOString() }
    this.suspensions.set(domain, suspension)
    return suspension
  }

  async unsuspendDomain(domain: string): Promise<boolean> {
    this.assertAvailable()
    return this.suspensions.delete(domain)
  }

  async listAddresses(domain: string): Promise<Address[]> {
    this.assertAvailable()
    return [...this.addresses.values()]
      .filter((address) => address.domain === domain)
      .sort((left, right) => left.localPart.localeCompare(right.localPart))
  }

  async findAddress(domain: string, localPart: string): Promise<Address | null> {
    this.assertAvailable()
    return this.addresses.get(key(domain, localPart)) ?? null
  }

  async putAddress(input: NewAddress): Promise<Address> {
    this.assertAvailable()
    const existing = this.addresses.get(key(input.domain, input.localPart))
    const address = { ...input, createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.addresses.set(key(input.domain, input.localPart), address)
    return address
  }

  async deleteAddress(domain: string, localPart: string): Promise<boolean> {
    this.assertAvailable()
    return this.addresses.delete(key(domain, localPart))
  }

  async hasOutboundMessage(wrapId: string): Promise<boolean> {
    this.assertAvailable()
    return this.outbound.has(wrapId)
  }

  async addOutboundMessage(input: NewOutboundMessage): Promise<void> {
    this.assertAvailable()
    if (this.outbound.has(input.wrapId)) return

    const queued = 'wrap' in input
    this.outbound.set(input.wrapId, {
      bridgePubkey: input.bridgePubkey,
      wrap: queued ? input.wrap : null,
      refusal: queued ? null : input.refusal,
      receivedAt: new Date().toISOString(),
      recipients: new Map(
        (queued ? input.recipients : []).map((address) => [
          address,
          { status: 'pending', attempts: 0, nextAttemptAt: new Date(), response: null },
        ]),
      ),
    })
  }

  async listDueOutboundMessages(limit: number): Promise<OutboundMessage[]> {
    this.assertAvailable()
    const now = Date.now()
    const due: OutboundMessage[] = []
    for (const [wrapId, message] of this.outbound) {
      const recipients = [...message.recipients]
        .filter(([, recipient]) => recipient.status === 'pending' && recipient.nextAttemptAt.getTime() <= now)
        .map(([address, { attempts }]) => ({ address, attempts }))
        .sort((left, right) => left.address.localeCompare(right.address))
      if (message.wrap && recipients.length) {
        due.push({
          wrapId,
          bridgePubkey: message.bridgePubkey,
          wrap: message.wrap,
          receivedAt: message.receivedAt,
          recipients,
        })
      }
    }
    return due.slice(0, limit)
  }

  async recordOutcomes(wrapId: string, outcomes: Map<string, RecipientOutcome>): Promise<void> {
    this.assertAvailable()
    const message = this.outbound.get(wrapId)
    if (!message) return

    for (const [address, outcome] of outcomes) {
      const recipient = message.recipients.get(address)
      if (!recipient) continue
      recipient.status = outcome.status
      recipient.response = outcome.response
      recipient.attempts++
      if ('nextAttemptAt' in outcome) recipient.nextAttemptAt = outcome.nextAttemptAt
    }
    if (![...message.recipients.values()].some((recipient) => recipient.status === 'pending')) message.wrap = null
  }

  async pruneOutboundMessages(before: Date): Promise<number> {
    this.assertAvailable()
    let pruned = 0
    for (const [wrapId, message] of this.outbound) {
      const pending = [...message.recipients.values()].some((recipient) => recipient.status === 'pending')
      if (Date.parse(message.receivedAt) < before.getTime() && !pending) {
        this.outbound.delete(wrapId)
        pruned++
      }
    }
    return pruned
  }

  async addAbuseReport({ emailId, message, ...input }: NewAbuseReport): Promise<void> {
    this.assertAvailable()
    if (this.abuseReports.some((kept) => kept.report.domain === input.domain && kept.emailId === emailId)) return

    const report = {
      ...input,
      id: this.abuseReports.length + 1,
      size: message.length,
      receivedAt: new Date().toISOString(),
    }
    this.abuseReports.push({ report, emailId, message })
  }

  async listAbuseReports(filter?: { domain: string; since: string }): Promise<AbuseReport[]> {
    this.assertAvailable()
    return this.abuseReports
      .map(({ report }) => report)
      .filter((report) => !filter || (report.domain === filter.domain && report.receivedAt >= filter.since))
      .reverse()
  }

  async findAbuseReport(id: number): Promise<{ report: AbuseReport; message: Buffer } | null> {
    this.assertAvailable()
    const kept = this.abuseReports.find(({ report }) => report.id === id)
    return kept ? { report: kept.report, message: kept.message } : null
  }

  async findOrCreateServerKey(generated: KeyPair): Promise<KeyPair> {
    this.assertAvailable()
    this.serverKey ??= generated
    return this.serverKey
  }

  // Mirrors the foreign keys: the addresses and the outbound mail of a claim go away with it.
  private dropClaim(domain: string, pubkey: string): boolean {
    for (const [addressKey, address] of this.addresses) {
      if (address.domain === domain && address.ownerPubkey === pubkey) this.addresses.delete(addressKey)
    }
    const claim = this.domains.get(key(domain, pubkey))
    for (const [wrapId, message] of this.outbound) {
      if (message.bridgePubkey === claim?.bridgePubkey) this.outbound.delete(wrapId)
    }
    return this.domains.delete(key(domain, pubkey))
  }

  private inService(claim: Domain): boolean {
    return claim.verifiedAt !== null && !this.suspensions.has(claim.domain)
  }

  private assertAvailable(): void {
    if (this.fail) throw new Error('database unavailable')
  }
}

const OWNERSHIP_ONLY: DomainChecks = {
  ownership: { status: 'ok', found: [] },
  mx: { status: 'missing', found: [] },
  https: { status: 'missing', found: [] },
  spf: { status: 'missing', found: [] },
  dkim: { status: 'missing', found: [] },
  dmarc: { status: 'missing', found: [] },
}

export function claim(domain: string, pubkey: string): NewDomain {
  const bridge = generateKeyPair()
  return {
    domain,
    pubkey,
    verificationToken: pubkey.slice(0, 32),
    dkimSelector: 'nostrmail',
    dkimPublicKey: 'public',
    dkimPrivateKey: 'private',
    bridgePubkey: bridge.pubkey,
    bridgePrivateKey: bridge.privateKey,
    blossomServers: domainConfig.blossomServers,
  }
}

const SENDING: DomainChecks = {
  ...OWNERSHIP_ONLY,
  spf: { status: 'ok', found: [] },
  dkim: { status: 'ok', found: [] },
}

// Stores a claim whose ownership, SPF and DKIM records were found, with a real DKIM key.
export async function sendingDomain(repo: DomainRepository, domain: string, pubkey: string): Promise<Domain> {
  const dkim = await generateDkimKeyPair()
  await repo.createDomain({ ...claim(domain, pubkey), dkimPublicKey: dkim.publicKey, dkimPrivateKey: dkim.privateKey })
  const sending = await repo.recordChecks(domain, pubkey, SENDING, true)
  if (!sending) throw new Error(`The claim on ${domain} disappeared`)
  return sending
}

interface OutboundOptions {
  mailFrom?: string
  rcptTo?: string[]
  content?: string
  tags?: string[][]
}

// A kind 1301 rumor gift wrapped to a domain key, as a Nostr Mail client sends mail for legacy recipients.
export function outboundWrap(sender: Signer, bridgePubkey: string, options: OutboundOptions = {}): NostrEvent {
  const mailFrom = options.mailFrom ?? `${npubEncode(sender.pubkey)}@example.com`
  const tags = [
    ['p', bridgePubkey],
    ['mail-from', mailFrom],
    ...(options.rcptTo ?? ['bob@remote.example']).map((address) => ['rcpt-to', address]),
    ...(options.tags ?? []),
  ]
  const content = options.content ?? `From: Alice <${mailFrom}>\nTo: bob@remote.example\nSubject: Hi\n\nHello Bob\n`
  return wrapEvent({ kind: 1301, tags, content }, sender.sk, bridgePubkey)
}

// Stores a claim whose ownership record was found, as a check would.
export async function verifyDomain(repo: DomainRepository, domain: string, pubkey: string): Promise<Domain> {
  await repo.createDomain(claim(domain, pubkey))
  const verified = await repo.recordChecks(domain, pubkey, OWNERSHIP_ONLY, true)
  if (!verified) throw new Error(`The claim on ${domain} disappeared`)
  return verified
}

export class FakeDns implements DnsLookup {
  readonly txtRecords = new Map<string, string[]>()
  readonly mxRecords = new Map<string, MxRecord[]>()
  readonly addressRecords = new Map<string, string[]>()
  // By IP address.
  readonly ptrRecords = new Map<string, string[]>()
  readonly failing = new Set<string>()

  // The same records, answered like dns.promises.resolve.
  readonly resolve: DNSResolver = async (name, rrtype) => {
    this.assertResolvable(name)
    const addresses = this.addressRecords.get(name) ?? []
    const answers: Record<string, unknown[]> = {
      TXT: (this.txtRecords.get(name) ?? []).map((value) => [value]),
      MX: this.mxRecords.get(name) ?? [],
      A: addresses.filter((address) => isIPv4(address)),
      AAAA: addresses.filter((address) => isIPv6(address)),
    }
    const found = answers[rrtype] ?? []
    if (!found.length) throw Object.assign(new Error(`query${rrtype} ENODATA ${name}`), { code: 'ENODATA' })
    return found as Awaited<ReturnType<DNSResolver>>
  }

  async txt(name: string): Promise<string[]> {
    this.assertResolvable(name)
    return this.txtRecords.get(name) ?? []
  }

  async mx(name: string): Promise<MxRecord[]> {
    this.assertResolvable(name)
    return this.mxRecords.get(name) ?? []
  }

  async addresses(name: string): Promise<string[]> {
    this.assertResolvable(name)
    return this.addressRecords.get(name) ?? []
  }

  async reverse(address: string): Promise<string[]> {
    this.assertResolvable(address)
    return this.ptrRecords.get(address) ?? []
  }

  private assertResolvable(name: string): void {
    if (this.failing.has(name)) throw Object.assign(new Error(`queryTxt ESERVFAIL ${name}`), { code: 'ESERVFAIL' })
  }
}

// Answers the TXT lookups of mailauth like dns.promises.resolve, any other name does not exist.
export class FakeAuthDns {
  readonly txtRecords = new Map<string, string[]>()
  readonly timingOut = new Set<string>()

  readonly resolve: DNSResolver = async (name, rrtype) => {
    if (this.timingOut.has(name))
      throw Object.assign(new Error(`query${rrtype} ETIMEOUT ${name}`), { code: 'ETIMEOUT' })
    const values = rrtype === 'TXT' ? this.txtRecords.get(name) : undefined
    if (!values) throw Object.assign(new Error(`query${rrtype} ENOTFOUND ${name}`), { code: 'ENOTFOUND' })
    return values.map((value) => [value])
  }
}

export interface FakeSubscription {
  relays: string[]
  filter: Filter
  authKey: Uint8Array
  onEvent: (event: NostrEvent) => void
  closed: boolean
}

export class FakeRelayNetwork implements RelayNetwork {
  readonly inboxRelays = new Map<string, string[]>()
  readonly blossomServers = new Map<string, string[]>()
  readonly down = new Set<string>()
  readonly published: { relays: string[]; event: NostrEvent; authKey: Uint8Array }[] = []
  readonly subscriptions: FakeSubscription[] = []

  async findInbox(pubkey: string): Promise<Inbox> {
    return { relays: this.inboxRelays.get(pubkey) ?? [], blossomServers: this.blossomServers.get(pubkey) ?? [] }
  }

  async publish(relays: string[], event: NostrEvent, authKey: Uint8Array): Promise<string[]> {
    this.published.push({ relays, event, authKey })
    return relays.filter((relay) => !this.down.has(relay))
  }

  subscribe(relays: string[], filter: Filter, authKey: Uint8Array, onEvent: (event: NostrEvent) => void): Subscription {
    const subscription = { relays, filter, authKey, onEvent, closed: false }
    this.subscriptions.push(subscription)
    return {
      close: () => {
        subscription.closed = true
      },
    }
  }

  open(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => !subscription.closed)
  }
}

export class FakeBlobStore implements BlobStore {
  readonly down = new Set<string>()
  readonly uploads: { servers: string[]; blob: EncryptedBlob; authKey: Uint8Array }[] = []
  // What each server holds, by hash.
  readonly stored = new Map<string, Map<string, Buffer>>()
  readonly downloads: string[][] = []

  async upload(servers: string[], blob: EncryptedBlob, authKey: Uint8Array): Promise<string[]> {
    this.uploads.push({ servers, blob, authKey })
    return servers.filter((server) => !this.down.has(server))
  }

  async download(servers: string[], sha256: string): Promise<Buffer | null> {
    this.downloads.push(servers)
    for (const server of servers) {
      const bytes = this.stored.get(server)?.get(sha256)
      if (bytes && !this.down.has(server)) return bytes
    }
    return null
  }

  store(server: string, blob: EncryptedBlob): void {
    this.stored.set(server, new Map([...(this.stored.get(server) ?? []), [blob.sha256, blob.bytes]]))
  }
}

// Decrypts a gift wrap (NIP-59) down to its seal and rumor.
export function openWrap(wrap: NostrEvent, secretKey: Uint8Array): { seal: NostrEvent; rumor: NostrEvent } {
  const seal = JSON.parse(decrypt(wrap.content, getConversationKey(secretKey, wrap.pubkey)))
  const rumor = JSON.parse(decrypt(seal.content, getConversationKey(secretKey, seal.pubkey)))
  return { seal, rumor }
}

export interface Signer {
  sk: Uint8Array
  pubkey: string
}

export function signer(): Signer {
  const sk = generateSecretKey()
  return { sk, pubkey: getPublicKey(sk) }
}

interface TokenOptions {
  method: string
  path: string
  host?: string
  createdAt?: number
  kind?: number
}

// The `Authorization: Nostr <base64>` value for a NIP-98 request on API_HOST.
export function authorization(sk: Uint8Array, options: TokenOptions): string {
  const event = finalizeEvent(
    {
      kind: options.kind ?? NIP98_KIND,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ['u', `https://${options.host ?? API_HOST}${options.path}`],
        ['method', options.method],
      ],
      content: '',
    },
    sk,
  )

  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

export type App = ReturnType<typeof buildApp>

export function request(
  app: App,
  user: Signer,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: path,
    headers: { host: API_HOST, authorization: authorization(user.sk, { method, path }) },
    payload,
  })
}

function key(domain: string, id: string): string {
  return `${domain}:${id}`
}

const FINAL_LINE = /^\d{3} .*\r\n/m

// Returns a function that resolves with the next complete SMTP reply on the socket.
export function replyReader(socket: Socket): () => Promise<string> {
  let buffer = ''
  let notify = () => {}
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    notify()
  })

  return async () => {
    let end = FINAL_LINE.exec(buffer)
    while (!end) {
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      end = FINAL_LINE.exec(buffer)
    }
    const text = buffer.slice(0, end.index + end[0].length)
    buffer = buffer.slice(text.length)
    return text
  }
}

// Self-signed test certificates for mx.example.org: tls-a and tls-b.
export function fixtureTlsFiles(name: 'a' | 'b'): TlsFiles {
  const path = (extension: string) => fileURLToPath(new URL(`./fixtures/tls-${name}.${extension}`, import.meta.url))
  return { certFile: path('crt'), keyFile: path('key') }
}

export function readFixtureTls(name: 'a' | 'b'): Promise<TlsCredentials> {
  return readTls(fixtureTlsFiles(name))
}
