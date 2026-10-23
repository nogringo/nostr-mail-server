import type { DNSResolver } from 'mailauth'
import type { NostrEvent } from 'nostr-tools/pure'

export interface AppConfig {
  port: number
  smtpPort: number
  databaseUrl: string
  mxHost: string
  spfInclude: string
  publicIpv4: string
  dkimSelector: string
  dnsServers: string[]
  tls: TlsFiles | null
  // Hex pubkeys allowed to see every domain of the server.
  adminPubkeys: string[]
}

// PEM files of the certificate SMTP offers with STARTTLS.
export interface TlsFiles {
  certFile: string
  keyFile: string
}

export type DomainConfig = Pick<AppConfig, 'mxHost' | 'spfInclude' | 'publicIpv4' | 'dkimSelector'>

export type ApiConfig = DomainConfig & Pick<AppConfig, 'adminPubkeys'>

export type RecordId = 'ownership' | 'mx' | 'nip05' | 'spf' | 'dkim' | 'dmarc'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface RecordCheck {
  status: CheckStatus
  found: string[]
}

export type DomainChecks = Record<RecordId, RecordCheck>

// A DNS record to publish, or the NIP-05 entry the owner's website lists.
export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT' | 'A' | 'NIP-05'
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
  // The domain's own key, served as _smtp@<domain>. The server holds its
  // private key, or the owner's bunker does.
  bridgePubkey: string
  bridgePrivateKey: string | null
  bridgeBunker: BunkerKey | null
  // Where the domain's large mail is stored, published as the kind 10063 of its key.
  blossomServers: string[]
  nip05: Nip05Host
  checks: DomainChecks | null
  checkedAt: string | null
  verifiedAt: string | null
  createdAt: string
}

// Who serves https://<domain>/.well-known/nostr.json: this server, which the
// domain's A record points to, or the owner's own website.
export type Nip05Host = 'server' | 'owner'

export type DomainSummary = Domain & {
  // The addresses its claim declared.
  addressCount: number
}

export interface Suspension {
  domain: string
  suspendedAt: string
}

export interface AllowedKey {
  pubkey: string
  allowedAt: string
}

// What the admins change from the /admin page.
export interface ServerSettings {
  // Any key may claim a domain, not only the admins and the allowed keys.
  openRegistration: boolean
  // Largest message received over SMTP, and largest blob read to send one.
  maxMessageBytes: number
  // Given to new claims for their large mail, and used by the server key.
  blossomServers: string[]
  // Announced by every domain key (kinds 10002 and 10050): its lists are published there, and its mail to send read.
  domainRelays: string[]
  // Where the lists of other keys are looked up.
  indexerRelays: string[]
}

// Domain relays taken off the settings, by the date the outbox stops listening to them.
export type RetiredRelays = Record<string, string>

export type StoredSettings = ServerSettings & { retiredDomainRelays: RetiredRelays }

// A NIP-46 remote signer that holds a domain key.
export interface BunkerKey {
  // The bunker's own key, which answers the requests.
  signerPubkey: string
  relays: string[]
  // The key this server connects with, which the bunker authorized.
  clientKey: string
}

export type BridgeKey = Pick<Domain, 'bridgePubkey' | 'bridgePrivateKey' | 'bridgeBunker'>

// A claim starts with a key the server holds.
export type NewDomain = Pick<
  Domain,
  | 'domain'
  | 'pubkey'
  | 'verificationToken'
  | 'dkimSelector'
  | 'dkimPublicKey'
  | 'dkimPrivateKey'
  | 'bridgePubkey'
  | 'blossomServers'
> & { bridgePrivateKey: string }

export interface Address {
  domain: string
  localPart: string
  pubkey: string
  // The verified owner of the domain, who declared the address.
  ownerPubkey: string
  // NIP-05 does not serve it: mail still reaches the pubkey, which nobody can look up.
  private: boolean
  createdAt: string
}

// Public unless said otherwise.
export type NewAddress = Pick<Address, 'domain' | 'localPart' | 'pubkey' | 'ownerPubkey'> &
  Partial<Pick<Address, 'private'>>

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

// The admins read the reports of every domain, the owner of a domain those received since its claim was
// verified. Each deletes a report for itself only.
export type AbuseReader = 'admin' | { domain: string; since: string }

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
  setNip05Host(domain: string, pubkey: string, nip05: Nip05Host): Promise<Domain | null>
  // Also drops the addresses the claim declared.
  deleteDomain(domain: string, pubkey: string): Promise<boolean>
  // Whether a claim on any domain has this key.
  hasBridgeKey(bridgePubkey: string): Promise<boolean>
  // Gives the claim another key, or moves its key between the server and a bunker. The outbound mail wrapped
  // to a replaced key goes, since nothing opens it any more.
  replaceBridgeKey(domain: string, pubkey: string, bridgeKey: BridgeKey): Promise<Domain | null>
  listSuspensions(): Promise<Suspension[]>
  findSuspension(domain: string): Promise<Suspension | null>
  // Returns the existing suspension when the domain is already suspended.
  suspendDomain(domain: string): Promise<Suspension>
  unsuspendDomain(domain: string): Promise<boolean>
  listAllowedKeys(): Promise<AllowedKey[]>
  isAllowedKey(pubkey: string): Promise<boolean>
  // Returns the existing entry when the key is already allowed.
  allowKey(pubkey: string): Promise<AllowedKey>
  disallowKey(pubkey: string): Promise<boolean>
  findSettings(): Promise<StoredSettings>
  updateSettings(settings: StoredSettings): Promise<void>
  listAddresses(domain: string): Promise<Address[]>
  findAddress(domain: string, localPart: string): Promise<Address | null>
  // Creates the address, or gives an existing one the new pubkey and privacy.
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
  // Newest first, without those the reader deleted.
  listAbuseReports(reader: AbuseReader): Promise<AbuseReport[]>
  findAbuseMessage(id: number, reader: AbuseReader): Promise<Buffer | null>
  deleteAbuseReport(id: number, reader: AbuseReader): Promise<boolean>
  // Stores `generated` as the server's key unless it already has one, and returns the stored key.
  findOrCreateServerKey(generated: KeyPair): Promise<KeyPair>
}

// What https://<domain>/.well-known/nostr.json lists for a name. NIP-05 clients
// ignore redirects, so a redirect is reported rather than followed.
export type Nip05Lookup = (domain: string, name: string) => Promise<{ pubkey: string | null } | { redirect: string }>

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
