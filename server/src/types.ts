export interface AppConfig {
  port: number
  databaseUrl: string
  mxHost: string
  spfInclude: string
  dkimSelector: string
  dnsServers: string[]
}

export type DomainConfig = Pick<AppConfig, 'mxHost' | 'spfInclude' | 'dkimSelector'>

export type RecordId = 'ownership' | 'mx' | 'spf' | 'dkim' | 'dmarc'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface RecordCheck {
  status: CheckStatus
  found: string[]
}

export type DomainChecks = Record<RecordId, RecordCheck>

export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT'
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
  checks: DomainChecks | null
  checkedAt: string | null
  verifiedAt: string | null
  createdAt: string
}

export type NewDomain = Pick<
  Domain,
  'domain' | 'pubkey' | 'verificationToken' | 'dkimSelector' | 'dkimPublicKey' | 'dkimPrivateKey'
>

export interface DomainRepository {
  findDomain(domain: string, pubkey: string): Promise<Domain | null>
  listDomains(pubkey: string): Promise<Domain[]>
  // Returns the existing claim when this pubkey already claimed the domain.
  createDomain(input: NewDomain): Promise<Domain>
  // A verified claim becomes the domain's owner: the other claims on it are dropped.
  recordChecks(domain: string, pubkey: string, checks: DomainChecks, verified: boolean): Promise<Domain | null>
  deleteDomain(domain: string, pubkey: string): Promise<boolean>
}

export interface MxRecord {
  exchange: string
  priority: number
}

export interface DnsLookup {
  // Each TXT record has its character strings joined. A missing name or type yields [].
  txt(name: string): Promise<string[]>
  mx(name: string): Promise<MxRecord[]>
}
