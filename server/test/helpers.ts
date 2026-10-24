import { isIPv4, isIPv6, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { DNSResolver } from 'mailauth'
import type { Filter } from 'nostr-tools/filter'
import { npubEncode } from 'nostr-tools/nip19'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import type { BunkerPointer } from 'nostr-tools/nip46'
import { wrapEvent } from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import type { buildApp } from '../src/app.js'
import type { BlobStore, EncryptedBlob } from '../src/blossom.js'
import type { BunkerConnection, OpenBunker } from '../src/bunker.js'
import { generateDkimKeyPair } from '../src/dkim.js'
import { NIP98_KIND } from '../src/nip98.js'
import { generateKeyPair } from '../src/nostr.js'
import { NO_QUOTAS } from '../src/quotas.js'
import type { Inbox, RelayNetwork, Subscription } from '../src/relays.js'
import { SettingsStore } from '../src/settings.js'
import { type KeySigner, localSigner } from '../src/signer.js'
import { readTls, type TlsCredentials } from '../src/tls.js'
import type {
  AbuseReader,
  AbuseReport,
  Address,
  AllowedKey,
  ApiConfig,
  BridgeKey,
  DeletedAddress,
  DnsLookup,
  Domain,
  DomainChecks,
  DomainConfig,
  DomainRepository,
  DomainSummary,
  KeyPair,
  KeyQuotas,
  MxRecord,
  NewAbuseReport,
  NewAddress,
  NewDomain,
  NewOutboundMessage,
  Nip05Host,
  Nip05Lookup,
  OutboundMessage,
  PeriodQuota,
  Quotas,
  RecipientOutcome,
  ServerSettings,
  StoredBlob,
  StoredSettings,
  Suspension,
  TlsFiles,
} from '../src/types.js'

export const API_HOST = 'app.example.org'

export const domainConfig: DomainConfig = {
  mxHost: 'mx.example.org',
  spfInclude: '_spf.example.org',
  publicIpv4: '192.0.2.10',
  dkimSelector: 'nostrmail',
}

export const apiConfig: ApiConfig = {
  ...domainConfig,
  adminPubkeys: [],
  nostrHost: 'nostr.mx.example.org',
  relayUrl: 'wss://nostr.mx.example.org/',
  blossomUrl: 'https://nostr.mx.example.org',
}

export const testSettings: ServerSettings = {
  openRegistration: false,
  maxMessageBytes: 1024 * 1024,
  maxBlobStorageBytes: 16 * 1024 * 1024,
  blossomServers: ['https://blossom.example.org'],
  indexerRelays: ['wss://indexer.example.org/'],
  quotas: NO_QUOTAS,
}

// The settings of the repository, with these changes stored first.
export function settingsStore(repo: MemoryDomainRepository, changes: Partial<StoredSettings> = {}): SettingsStore {
  repo.storedSettings = { ...repo.storedSettings, ...changes }
  return new SettingsStore(repo, repo.storedSettings)
}

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
  blobSha256: string | null
  receivedAt: string
  recipients: Map<string, StoredRecipient>
}

// Never dropped: a report both sides deleted only leaves their lists.
export interface StoredAbuseReport {
  report: AbuseReport
  emailId: string
  message: Buffer
  adminDeleted: boolean
  ownerDeleted: boolean
}

export class MemoryDomainRepository implements DomainRepository {
  readonly domains = new Map<string, Domain>()
  readonly addresses = new Map<string, Address>()
  readonly deletedAddresses = new Map<string, DeletedAddress & { ownerPubkey: string }>()
  readonly outbound = new Map<string, StoredOutboundMessage>()
  readonly blobs = new Map<string, StoredBlob & { uploader: string }>()
  readonly suspensions = new Map<string, Suspension>()
  readonly allowedKeys = new Map<string, AllowedKey>()
  readonly keyQuotas = new Map<string, KeyQuotas>()
  quotaUsage: { quota: PeriodQuota; subject: string; amount: number; usedAt: Date }[] = []
  storedSettings: StoredSettings = {
    ...testSettings,
    domainRelays: [apiConfig.relayUrl],
    domainBlossomServer: apiConfig.blossomUrl,
    retiredDomainRelays: {},
  }
  readonly servedDomains = new Set<string>()
  serverKey: KeyPair | null = null
  readonly abuseReports: StoredAbuseReport[] = []
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
      bridgeBunker: null,
      nip05: 'server',
      shared: false,
      catchAll: false,
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

  async setNip05Host(domain: string, pubkey: string, nip05: Nip05Host): Promise<Domain | null> {
    this.assertAvailable()
    const current = this.domains.get(key(domain, pubkey))
    if (!current) return null

    const next = { ...current, nip05 }
    this.domains.set(key(domain, pubkey), next)
    return next
  }

  async setShared(domain: string, pubkey: string, shared: boolean): Promise<Domain | null> {
    this.assertAvailable()
    const current = this.domains.get(key(domain, pubkey))
    if (!current) return null

    const next = { ...current, shared }
    this.domains.set(key(domain, pubkey), next)
    return next
  }

  async setCatchAll(domain: string, pubkey: string, catchAll: boolean): Promise<Domain | null> {
    this.assertAvailable()
    const current = this.domains.get(key(domain, pubkey))
    if (!current) return null

    const next = { ...current, catchAll }
    this.domains.set(key(domain, pubkey), next)
    return next
  }

  async listSharedDomains(): Promise<string[]> {
    this.assertAvailable()
    return [...this.domains.values()]
      .filter((claim) => claim.shared && this.inService(claim))
      .map((claim) => claim.domain)
      .sort()
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.dropClaim(domain, pubkey)
  }

  async hasBridgeKey(bridgePubkey: string): Promise<boolean> {
    this.assertAvailable()
    return [...this.domains.values()].some((claim) => claim.bridgePubkey === bridgePubkey)
  }

  async replaceBridgeKey(domain: string, pubkey: string, bridgeKey: BridgeKey): Promise<Domain | null> {
    this.assertAvailable()
    const current = this.domains.get(key(domain, pubkey))
    if (!current) return null

    for (const [wrapId, message] of this.outbound) {
      if (message.bridgePubkey === current.bridgePubkey && current.bridgePubkey !== bridgeKey.bridgePubkey) {
        this.outbound.delete(wrapId)
      }
    }
    const next = { ...current, ...bridgeKey }
    this.domains.set(key(domain, pubkey), next)
    return next
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

  async listAllowedKeys(): Promise<AllowedKey[]> {
    this.assertAvailable()
    return [...this.allowedKeys.values()]
  }

  async isAllowedKey(pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.allowedKeys.has(pubkey)
  }

  async allowKey(pubkey: string): Promise<AllowedKey> {
    this.assertAvailable()
    const allowedKey = this.allowedKeys.get(pubkey) ?? { pubkey, allowedAt: new Date().toISOString() }
    this.allowedKeys.set(pubkey, allowedKey)
    return allowedKey
  }

  async disallowKey(pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.allowedKeys.delete(pubkey)
  }

  async listKeyQuotas(): Promise<KeyQuotas[]> {
    this.assertAvailable()
    return [...this.keyQuotas.values()]
  }

  async findKeyQuotas(pubkey: string): Promise<KeyQuotas | null> {
    this.assertAvailable()
    return this.keyQuotas.get(pubkey) ?? null
  }

  async putKeyQuotas(pubkey: string, quotas: Partial<Quotas>): Promise<KeyQuotas> {
    this.assertAvailable()
    const keyQuotas = { pubkey, quotas, updatedAt: new Date().toISOString() }
    this.keyQuotas.set(pubkey, keyQuotas)
    return keyQuotas
  }

  async deleteKeyQuotas(pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.keyQuotas.delete(pubkey)
  }

  async addQuotaUsage(quota: PeriodQuota, subject: string, amount: number): Promise<void> {
    this.assertAvailable()
    this.quotaUsage.push({ quota, subject, amount, usedAt: new Date() })
  }

  async countQuotaUsage(quota: PeriodQuota, subject: string, since: Date): Promise<number> {
    this.assertAvailable()
    return this.quotaUsage
      .filter((usage) => usage.quota === quota && usage.subject === subject && usage.usedAt >= since)
      .reduce((total, usage) => total + usage.amount, 0)
  }

  async pruneQuotaUsage(before: Date): Promise<number> {
    this.assertAvailable()
    const kept = this.quotaUsage.filter((usage) => usage.usedAt >= before)
    const pruned = this.quotaUsage.length - kept.length
    this.quotaUsage = kept
    return pruned
  }

  async findSettings(): Promise<StoredSettings> {
    this.assertAvailable()
    return this.storedSettings
  }

  async updateSettings(settings: StoredSettings): Promise<void> {
    this.assertAvailable()
    this.storedSettings = settings
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

  async listCreatedAddresses(createdBy: string): Promise<Address[]> {
    this.assertAvailable()
    return [...this.addresses.values()]
      .filter((address) => address.createdBy === createdBy && address.ownerPubkey !== createdBy)
      .sort((left, right) => left.domain.localeCompare(right.domain) || left.localPart.localeCompare(right.localPart))
  }

  async countCreatedAddresses(createdBy: string): Promise<number> {
    this.assertAvailable()
    return [...this.addresses.values()].filter((address) => address.createdBy === createdBy).length
  }

  async putAddress(input: NewAddress): Promise<Address> {
    this.assertAvailable()
    const existing = this.addresses.get(key(input.domain, input.localPart))
    const address = {
      ...input,
      createdBy:
        existing?.pubkeys.join() === input.pubkeys.join() ? existing.createdBy : (input.createdBy ?? input.ownerPubkey),
      private: input.private ?? false,
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    this.addresses.set(key(input.domain, input.localPart), address)
    return address
  }

  async putCreatedAddress(input: NewAddress & { createdBy: string }): Promise<Address | null> {
    this.assertAvailable()
    const existing = this.addresses.get(key(input.domain, input.localPart))
    if (existing && existing.createdBy !== input.createdBy) return null

    const settings = { private: input.private ?? false, enabled: input.enabled ?? true }
    const address = existing
      ? { ...existing, ...settings }
      : { ...input, ...settings, createdAt: new Date().toISOString() }
    this.addresses.set(key(input.domain, input.localPart), address)
    return address
  }

  async createCatchAllAddress(domain: Domain, localPart: string): Promise<Address | null> {
    this.assertAvailable()
    const existing = this.addresses.get(key(domain.domain, localPart))
    if (existing) return existing
    if (this.deletedAddresses.has(key(domain.domain, localPart))) return null

    const address = {
      domain: domain.domain,
      localPart,
      pubkeys: [domain.pubkey],
      ownerPubkey: domain.pubkey,
      createdBy: domain.pubkey,
      private: true,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    this.addresses.set(key(domain.domain, localPart), address)
    return address
  }

  async deleteAddress(domain: string, localPart: string, createdBy?: string): Promise<boolean> {
    this.assertAvailable()
    const existing = this.addresses.get(key(domain, localPart))
    if (!existing || (createdBy !== undefined && existing.createdBy !== createdBy)) return false

    this.addresses.delete(key(domain, localPart))
    this.deletedAddresses.set(key(domain, localPart), {
      domain,
      localPart,
      ownerPubkey: existing.ownerPubkey,
      deletedAt: new Date().toISOString(),
    })
    return true
  }

  async listDeletedAddresses(domain: string): Promise<DeletedAddress[]> {
    this.assertAvailable()
    return [...this.deletedAddresses.values()]
      .filter((deleted) => deleted.domain === domain)
      .sort((left, right) => left.localPart.localeCompare(right.localPart))
      .map(({ ownerPubkey: _, ...deleted }) => deleted)
  }

  async isDeletedAddress(domain: string, localPart: string): Promise<boolean> {
    this.assertAvailable()
    return this.deletedAddresses.has(key(domain, localPart))
  }

  async allowDeletedAddresses(domain: string, localPart?: string): Promise<number> {
    this.assertAvailable()
    let allowed = 0
    for (const [deletedKey, deleted] of this.deletedAddresses) {
      if (deleted.domain === domain && (localPart === undefined || deleted.localPart === localPart)) {
        this.deletedAddresses.delete(deletedKey)
        allowed++
      }
    }
    return allowed
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
      blobSha256: queued ? (input.blobSha256 ?? null) : null,
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

  async addBlob(sha256: string, data: Buffer, uploader: string): Promise<void> {
    this.assertAvailable()
    if (!this.blobs.has(sha256))
      this.blobs.set(sha256, { sha256, data, uploader, uploadedAt: new Date().toISOString() })
  }

  async countBlobBytes(): Promise<number> {
    this.assertAvailable()
    return [...this.blobs.values()].reduce((total, blob) => total + blob.data.length, 0)
  }

  async findBlob(sha256: string): Promise<StoredBlob | null> {
    this.assertAvailable()
    const blob = this.blobs.get(sha256)
    return blob ? { sha256: blob.sha256, data: blob.data, uploadedAt: blob.uploadedAt } : null
  }

  async wakeBlobRecipients(sha256: string): Promise<number> {
    this.assertAvailable()
    let woken = 0
    for (const message of this.outbound.values()) {
      if (message.blobSha256 !== sha256) continue
      for (const recipient of message.recipients.values()) {
        if (recipient.status !== 'pending') continue
        recipient.nextAttemptAt = new Date()
        woken++
      }
    }
    return woken
  }

  async pruneBlobs(before: Date): Promise<number> {
    this.assertAvailable()
    const messages = [...this.outbound.values()]
    let pruned = 0
    for (const [sha256, blob] of this.blobs) {
      const taking = messages.filter((message) => message.blobSha256 === sha256)
      const pending = taking.some((message) =>
        [...message.recipients.values()].some((recipient) => recipient.status === 'pending'),
      )
      if (!pending && (Date.parse(blob.uploadedAt) < before.getTime() || taking.length)) {
        this.blobs.delete(sha256)
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
    this.abuseReports.push({ report, emailId, message, adminDeleted: false, ownerDeleted: false })
  }

  async listAbuseReports(reader: AbuseReader): Promise<AbuseReport[]> {
    this.assertAvailable()
    return this.abuseReports
      .filter((stored) => keptBy(stored, reader))
      .map(({ report }) => report)
      .reverse()
  }

  async findAbuseMessage(id: number, reader: AbuseReader): Promise<Buffer | null> {
    this.assertAvailable()
    return this.abuseReports.find((stored) => stored.report.id === id && keptBy(stored, reader))?.message ?? null
  }

  async deleteAbuseReport(id: number, reader: AbuseReader): Promise<boolean> {
    this.assertAvailable()
    const kept = this.abuseReports.find((stored) => stored.report.id === id && keptBy(stored, reader))
    if (!kept) return false

    if (reader === 'admin') kept.adminDeleted = true
    else kept.ownerDeleted = true
    return true
  }

  async findOrCreateServerKey(generated: KeyPair): Promise<KeyPair> {
    this.assertAvailable()
    this.serverKey ??= generated
    return this.serverKey
  }

  // Mirrors the foreign keys: the addresses and the outbound mail of a claim go away with it.
  private dropClaim(domain: string, pubkey: string): boolean {
    for (const addresses of [this.addresses, this.deletedAddresses]) {
      for (const [addressKey, address] of addresses) {
        if (address.domain === domain && address.ownerPubkey === pubkey) addresses.delete(addressKey)
      }
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
  nip05: { status: 'missing', found: [] },
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
    blossomServers: testSettings.blossomServers,
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

export type Nip05Answers = Record<string, Awaited<ReturnType<Nip05Lookup>>>

// Answers the nostr.json of each domain, keyed by NIP-05 address: anything else lists nothing.
export function fakeNip05(answers: Nip05Answers = {}): Nip05Lookup {
  return async (domain, name) => answers[`${name}@${domain}`] ?? { pubkey: null }
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
  auth: KeySigner
  onEvent: (event: NostrEvent) => void
  closed: boolean
}

export class FakeRelayNetwork implements RelayNetwork {
  readonly inboxRelays = new Map<string, string[]>()
  readonly blossomServers = new Map<string, string[]>()
  readonly down = new Set<string>()
  readonly published: { relays: string[]; event: NostrEvent; auth: KeySigner }[] = []
  readonly subscriptions: FakeSubscription[] = []

  async findInbox(pubkey: string): Promise<Inbox> {
    return { relays: this.inboxRelays.get(pubkey) ?? [], blossomServers: this.blossomServers.get(pubkey) ?? [] }
  }

  async publish(relays: string[], event: NostrEvent, auth: KeySigner): Promise<string[]> {
    this.published.push({ relays, event, auth })
    return relays.filter((relay) => !this.down.has(relay))
  }

  subscribe(relays: string[], filter: Filter, auth: KeySigner, onEvent: (event: NostrEvent) => void): Subscription {
    const subscription = { relays, filter, auth, onEvent, closed: false }
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
  readonly uploads: { servers: string[]; blob: EncryptedBlob; auth: KeySigner }[] = []
  // What each server holds, by hash.
  readonly stored = new Map<string, Map<string, Buffer>>()
  readonly downloads: string[][] = []

  async upload(servers: string[], blob: EncryptedBlob, auth: KeySigner): Promise<string[]> {
    this.uploads.push({ servers, blob, auth })
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

export const BUNKER_RELAY = 'wss://bunker.example.org/'

// A NIP-46 remote signer answering from a local key, as BunkerSigner of
// nostr-tools hands its answers over: an error comes as a plain string.
export class FakeBunker {
  readonly signerKey = signer()
  // What the server stored when it connected.
  readonly clientKey = Buffer.from(generateSecretKey()).toString('hex')
  readonly requests: { clientPubkey: string; pointer: BunkerPointer; method: string; params: string[] }[] = []
  readonly opened: BunkerPointer[] = []
  // Never answers, like a bunker that is offline.
  silent = false
  refusing: string | null = null
  authUrl: string | null = null
  closed = 0

  constructor(readonly key: Signer = signer()) {}

  get url(): string {
    return `bunker://${this.signerKey.pubkey}?relay=wss%3A%2F%2Fbunker.example.org&secret=s3cret`
  }

  readonly open: OpenBunker = (clientKey, pointer, onauth): BunkerConnection => {
    this.opened.push(pointer)
    return {
      sendRequest: async (method, params) => {
        this.requests.push({ clientPubkey: getPublicKey(clientKey), pointer, method, params })
        if (this.authUrl) onauth(this.authUrl)
        if (this.silent || this.authUrl) return new Promise<string>(() => {})
        if (this.refusing) throw this.refusing
        return this.answer(method, params)
      },
      close: async () => {
        this.closed++
      },
    }
  }

  // The domain key, as stored once the bunker is connected.
  bridgeKey(): BridgeKey {
    return {
      bridgePubkey: this.key.pubkey,
      bridgePrivateKey: null,
      bridgeBunker: { signerPubkey: this.signerKey.pubkey, relays: [BUNKER_RELAY], clientKey: this.clientKey },
    }
  }

  methods(): string[] {
    return this.requests.map((request) => request.method)
  }

  private answer(method: string, params: string[]): string {
    const conversation = (pubkey: string) => getConversationKey(this.key.sk, pubkey)
    switch (method) {
      case 'connect':
        return 'ack'
      case 'get_public_key':
        return this.key.pubkey
      case 'sign_event':
        return JSON.stringify(finalizeEvent(JSON.parse(params[0]), this.key.sk))
      case 'nip44_encrypt':
        return encrypt(params[1], conversation(params[0]))
      case 'nip44_decrypt':
        return decrypt(params[1], conversation(params[0]))
      default:
        throw `unknown method ${method}`
    }
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

export function keySigner(user: Signer): KeySigner {
  return localSigner(Buffer.from(user.sk).toString('hex'))
}

export function privateKeyOf(domain: BridgeKey): string {
  if (domain.bridgePrivateKey === null) throw new Error(`The key of ${domain.bridgePubkey} is in a bunker`)
  return domain.bridgePrivateKey
}

// A new key the server holds.
export function newBridgeKey(): BridgeKey {
  const { pubkey, privateKey } = generateKeyPair()
  return { bridgePubkey: pubkey, bridgePrivateKey: privateKey, bridgeBunker: null }
}

// The signer of a domain key the server holds.
export function heldKey(domain: BridgeKey): KeySigner {
  return localSigner(privateKeyOf(domain))
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
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
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

function keptBy(stored: StoredAbuseReport, reader: AbuseReader): boolean {
  if (reader === 'admin') return !stored.adminDeleted
  return !stored.ownerDeleted && stored.report.domain === reader.domain && stored.report.receivedAt >= reader.since
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
