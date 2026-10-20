import type { DNSResolver } from 'mailauth'
import type { NostrEvent } from 'nostr-tools/pure'

export interface AppConfig {
  port: number
  smtpPort: number
  maxMessageBytes: number
  databaseUrl: string
  mxHost: string
  spfInclude: string
  publicIpv4: string
  dkimSelector: string
  dnsServers: string[]
  indexerRelays: string[]
  domainRelays: string[]
  blossomServers: string[]
  tls: TlsFiles | null
  // Hex pubkeys allowed to see every domain of the server.
  adminPubkeys: string[]
}

// PEM files of the certificate SMTP offers with STARTTLS.
export interface TlsFiles {
  certFile: string
  keyFile: string
}

export type DomainConfig = Pick<
  AppConfig,
  'mxHost' | 'spfInclude' | 'publicIpv4' | 'dkimSelector' | 'indexerRelays' | 'domainRelays' | 'blossomServers'
>

export type ApiConfig = DomainConfig & Pick<AppConfig, 'adminPubkeys'>

export type RecordId = 'ownership' | 'mx' | 'https' | 'spf' | 'dkim' | 'dmarc'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface RecordCheck {
  status: CheckStatus
  found: string[]
}

export type DomainChecks = Record<RecordId, RecordCheck>

export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT' | 'A'
  name: string
  value: string
  priority?: number
  required: boolean
}

// What the server itself needs in DNS, and what a check of it found.
export interface ServerRecord {
  id: 'host' | 'ptr' | 'spf'
  type: 'A' | 'PTR' | 'TXT'
  name: string
  value: string
  check: RecordCheck
}

export interface Domain {
  domain: string
  pubkey: string
  verificationToken: string
  dkimSelector: string
  dkimPublicKey: string
  dkimPrivateKey: string
  // The domain's own key, served as _smtp@<domain>.
  bridgePubkey: string
  bridgePrivateKey: string
  // Where the domain's large mail is stored, published as the kind 10063 of its key.
  blossomServers: string[]
  checks: DomainChecks | null
  checkedAt: string | null
  verifiedAt: string | null
  createdAt: string
}

export type DomainSummary = Domain & {
  // The addresses its claim declared.
  addressCount: number
}

export interface Suspension {
  domain: string
  suspendedAt: string
}

export type NewDomain = Pick<
  Domain,
  | 'domain'
  | 'pubkey'
  | 'verificationToken'
  | 'dkimSelector'
  | 'dkimPublicKey'
  | 'dkimPrivateKey'
  | 'bridgePubkey'
  | 'bridgePrivateKey'
  | 'blossomServers'
>

export interface Address {
  domain: string
  localPart: string
  pubkey: string
  // The verified owner of the domain, who declared the address.
  ownerPubkey: string
  createdAt: string
}

export type NewAddress = Pick<Address, 'domain' | 'localPart' | 'pubkey' | 'ownerPubkey'>

// A gift wrap addressed to a domain key: queued with its recipients, or refused.
export type NewOutboundMessage = { wrapId: string; bridgePubkey: string } & (
  | { wrap: NostrEvent; recipients: string[] }
  | { refusal: string }
)

export interface OutboundMessage {
  wrapId: string
  bridgePubkey: string
  wrap: NostrEvent
  receivedAt: string
  // The recipients due for an attempt.
  recipients: { address: string; attempts: number }[]
}

// Mail sent to abuse@ of a domain, as listed: the message is read on its own.
export interface AbuseReport {
  id: number
  domain: string
  mailFrom: string
  // The From and Subject fields, decoded.
  from: string
  subject: string
  size: number
  receivedAt: string
}

export type NewAbuseReport = Pick<AbuseReport, 'domain' | 'mailFrom' | 'from' | 'subject'> & {
  emailId: string
  message: Buffer
}

export interface KeyPair {
  pubkey: string
  privateKey: string
}

export type RecipientOutcome =
  | { status: 'delivered' | 'failed'; response: string }
  | { status: 'pending'; response: string; nextAttemptAt: Date }

export interface DomainRepository {
  findDomain(domain: string, pubkey: string): Promise<Domain | null>
  // The verified lookups leave the suspended domains out: nothing is served for them.
  findVerifiedDomain(domain: string): Promise<Domain | null>
  findVerifiedDomainByBridgePubkey(bridgePubkey: string): Promise<Domain | null>
  // The verified claim, also while the domain is suspended: only its abuse@ is served then.
  findOwnedDomain(domain: string): Promise<Domain | null>
  // Whether a claim on the domain was ever verified, released since or not.
  hasServedDomain(domain: string): Promise<boolean>
  listVerifiedDomains(): Promise<Domain[]>
  listDomains(pubkey: string): Promise<Domain[]>
  // Every claim of every key, verified or not.
  listAllDomains(): Promise<DomainSummary[]>
  // Returns the existing claim when this pubkey already claimed the domain.
  createDomain(input: NewDomain): Promise<Domain>
  // A verified claim becomes the domain's owner: the other claims on it, and their addresses, are dropped.
  // The domain is then served for good.
  recordChecks(domain: string, pubkey: string, checks: DomainChecks, verified: boolean): Promise<Domain | null>
  // Also drops the addresses the claim declared.
  deleteDomain(domain: string, pubkey: string): Promise<boolean>
  listSuspensions(): Promise<Suspension[]>
  findSuspension(domain: string): Promise<Suspension | null>
  // Returns the existing suspension when the domain is already suspended.
  suspendDomain(domain: string): Promise<Suspension>
  unsuspendDomain(domain: string): Promise<boolean>
  listAddresses(domain: string): Promise<Address[]>
  findAddress(domain: string, localPart: string): Promise<Address | null>
  // Creates the address, or points an existing one at the new pubkey.
  putAddress(input: NewAddress): Promise<Address>
  deleteAddress(domain: string, localPart: string): Promise<boolean>
  hasOutboundMessage(wrapId: string): Promise<boolean>
  // Does nothing when the wrap is already known.
  addOutboundMessage(input: NewOutboundMessage): Promise<void>
  listDueOutboundMessages(limit: number): Promise<OutboundMessage[]>
  // The wrap is dropped once no recipient is pending.
  recordOutcomes(wrapId: string, outcomes: Map<string, RecipientOutcome>): Promise<void>
  // Deletes the messages received before `before` that wait for nothing.
  pruneOutboundMessages(before: Date): Promise<number>
  // Does nothing when the domain already has this message.
  addAbuseReport(input: NewAbuseReport): Promise<void>
  // Newest first, every domain's without a filter.
  listAbuseReports(filter?: { domain: string; since: string }): Promise<AbuseReport[]>
  findAbuseReport(id: number): Promise<{ report: AbuseReport; message: Buffer } | null>
  // Stores `generated` as the server's key unless it already has one, and returns the stored key.
  findOrCreateServerKey(generated: KeyPair): Promise<KeyPair>
}

export interface MxRecord {
  exchange: string
  priority: number
}

export interface DnsLookup {
  // Each TXT record has its character strings joined. A missing name or type yields [].
  txt(name: string): Promise<string[]>
  mx(name: string): Promise<MxRecord[]>
  // The A and AAAA records.
  addresses(name: string): Promise<string[]>
  // The host names of the PTR records of an IP address.
  reverse(address: string): Promise<string[]>
  // The raw answers mailauth evaluates SPF with.
  resolve: DNSResolver
}
