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

export interface DomainRepository {
  findDomain(domain: string, pubkey: string): Promise<Domain | null>
  findVerifiedDomain(domain: string): Promise<Domain | null>
  listDomains(pubkey: string): Promise<Domain[]>
  // Returns the existing claim when this pubkey already claimed the domain.
  createDomain(input: NewDomain): Promise<Domain>
  // A verified claim becomes the domain's owner: the other claims on it, and their addresses, are dropped.
  recordChecks(domain: string, pubkey: string, checks: DomainChecks, verified: boolean): Promise<Domain | null>
  // Also drops the addresses the claim declared.
  deleteDomain(domain: string, pubkey: string): Promise<boolean>
  listAddresses(domain: string): Promise<Address[]>
  findAddress(domain: string, localPart: string): Promise<Address | null>
  // Creates the address, or points an existing one at the new pubkey.
  putAddress(input: NewAddress): Promise<Address>
  deleteAddress(domain: string, localPart: string): Promise<boolean>
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
}
