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
  // Where the server's own relay and Blossom server answer, the only ones the domain keys announce.
  nostrHost: string
  relayUrl: string
  blossomUrl: string
}

// PEM files of the certificate SMTP offers with STARTTLS.
export interface TlsFiles {
  certFile: string
  keyFile: string
}

export type DomainConfig = Pick<AppConfig, 'mxHost' | 'spfInclude' | 'publicIpv4' | 'dkimSelector'>

export type ApiConfig = DomainConfig & Pick<AppConfig, 'adminPubkeys' | 'nostrHost' | 'relayUrl' | 'blossomUrl'>

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
  id: 'host' | 'ptr' | 'spf' | 'nostr'
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
  // Any key may create addresses on it for itself.
  shared: boolean
  // Mail to an address it does not know creates that address for the owner.
  catchAll: boolean
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
  // Largest size of the blobs the server holds together, past which uploads are refused.
  maxBlobStorageBytes: number
  // Given to new claims for their large mail, and used by the server key.
  blossomServers: string[]
  // Where the lists of other keys are looked up, and those of the domain keys published.
  indexerRelays: string[]
  quotas: Quotas
}

// What a key may do, null for no limit.
export interface Quotas {
  // Addresses it holds on every domain: those it created by hand, and those the catch-all of its domains created.
  addresses: number | null
  // Addresses it creates in an hour, deleted since or not.
  addressesPerHour: number | null
  // Domains it claimed whose ownership record is not found yet.
  pendingDomains: number | null
  // Recipients each of its domains sends mail to in a day.
  recipientsPerDay: number | null
  // Keys one of its addresses delivers to.
  keysPerAddress: number | null
}

export type QuotaName = keyof Quotas

// The quotas that count what was done over a period.
export type PeriodQuota = 'addressesPerHour' | 'recipientsPerDay'

// The quotas an admin gave one key instead of the server's.
export interface KeyQuotas {
  pubkey: string
  quotas: Partial<Quotas>
  updatedAt: string
}

// Relays the domain keys no longer announce, by the date the outbox stops listening to them.
export type RetiredRelays = Record<string, string>

// The relay (kinds 10002 and 10050) and the Blossom server (kind 10063) the domain keys announce, the server's
// own: kept to see them change.
export type StoredSettings = ServerSettings & {
  domainRelays: string[]
  domainBlossomServer: string | null
  retiredDomainRelays: RetiredRelays
}

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
  // Each one gets the mail and sends from the address. NIP-05 serves the key of an address with only one.
  pubkeys: string[]
  // The verified owner of the domain, whose claim the address goes away with.
  ownerPubkey: string
  // Who manages it besides the owner: the owner, or the key that created it on a shared domain.
  createdBy: string
  // NIP-05 does not serve it: mail still reaches the pubkeys, which nobody can look up.
  private: boolean
  // Mail to it is taken and dropped, so the sender cannot tell. It still sends.
  enabled: boolean
  createdAt: string
}

// Public, enabled and created by the owner unless said otherwise.
export type NewAddress = Pick<Address, 'domain' | 'localPart' | 'pubkeys' | 'ownerPubkey'> &
  Partial<Pick<Address, 'createdBy' | 'private' | 'enabled'>>

// Nothing creates it again until the owner of the domain allows it.
export interface DeletedAddress {
  domain: string
  localPart: string
  deletedAt: string
}

// A gift wrap addressed to a domain key: queued with its recipients and the blob its email is in, or refused.
export type NewOutboundMessage = { wrapId: string; bridgePubkey: string } & (
  | { wrap: NostrEvent; recipients: string[]; blobSha256?: string }
  | { refusal: string }
)

// A blob a client uploaded to the server's Blossom endpoint.
export interface StoredBlob {
  sha256: string
  data: Buffer
  uploadedAt: string
}

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
  setShared(domain: string, pubkey: string, shared: boolean): Promise<Domain | null>
  setCatchAll(domain: string, pubkey: string, catchAll: boolean): Promise<Domain | null>
  // The shared domains in service.
  listSharedDomains(): Promise<string[]>
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
  listKeyQuotas(): Promise<KeyQuotas[]>
  findKeyQuotas(pubkey: string): Promise<KeyQuotas | null>
  // Replaces the quotas the key had of its own.
  putKeyQuotas(pubkey: string, quotas: Partial<Quotas>): Promise<KeyQuotas>
  deleteKeyQuotas(pubkey: string): Promise<boolean>
  addQuotaUsage(quota: PeriodQuota, subject: string, amount: number): Promise<void>
  // What the subject used of the quota since then.
  countQuotaUsage(quota: PeriodQuota, subject: string, since: Date): Promise<number>
  pruneQuotaUsage(before: Date): Promise<number>
  findSettings(): Promise<StoredSettings>
  updateSettings(settings: StoredSettings): Promise<void>
  listAddresses(domain: string): Promise<Address[]>
  findAddress(domain: string, localPart: string): Promise<Address | null>
  // The addresses a key created on the domains of other keys.
  listCreatedAddresses(createdBy: string): Promise<Address[]>
  // The addresses a key created, on its domains and on those of other keys.
  countCreatedAddresses(createdBy: string): Promise<number>
  // Creates the address, or gives an existing one the new pubkeys, privacy and state. An address given other
  // pubkeys is managed by `createdBy` from then on, one that keeps its pubkeys by the same key.
  putAddress(input: NewAddress): Promise<Address>
  // Creates the address, or changes the privacy and state of one the same key created. Returns null when it is
  // another key's.
  putCreatedAddress(input: NewAddress & { createdBy: string }): Promise<Address | null>
  // Creates the address for the owner of the domain, private, or returns the existing one. Returns null
  // when it was deleted.
  createCatchAllAddress(domain: Domain, localPart: string): Promise<Address | null>
  // With `createdBy`, only an address that key created. The address is kept among the deleted ones.
  deleteAddress(domain: string, localPart: string, createdBy?: string): Promise<boolean>
  listDeletedAddresses(domain: string): Promise<DeletedAddress[]>
  isDeletedAddress(domain: string, localPart: string): Promise<boolean>
  // Lets the address be created again, or all of them without `localPart`. Returns how many it let go.
  allowDeletedAddresses(domain: string, localPart?: string): Promise<number>
  hasOutboundMessage(wrapId: string): Promise<boolean>
  // Does nothing when the wrap is already known.
  addOutboundMessage(input: NewOutboundMessage): Promise<void>
  listDueOutboundMessages(limit: number): Promise<OutboundMessage[]>
  // The wrap is dropped once no recipient is pending.
  recordOutcomes(wrapId: string, outcomes: Map<string, RecipientOutcome>): Promise<void>
  // Deletes the messages received before `before` that wait for nothing.
  pruneOutboundMessages(before: Date): Promise<number>
  // Does nothing when the blob is already stored.
  addBlob(sha256: string, data: Buffer, uploader: string): Promise<void>
  // The size of every blob stored.
  countBlobBytes(): Promise<number>
  findBlob(sha256: string): Promise<StoredBlob | null>
  // Makes the recipients of the emails in the blob due now. Returns how many.
  wakeBlobRecipients(sha256: string): Promise<number>
  // Deletes the blobs no email waits for: those of emails no longer pending, and those no email took that were
  // uploaded before `before`.
  pruneBlobs(before: Date): Promise<number>
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
