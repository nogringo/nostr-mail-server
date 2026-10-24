import { getToken } from 'nostr-tools/nip98'
import type { Signer } from './signer'

export type RecordId = 'ownership' | 'mx' | 'nip05' | 'spf' | 'dkim' | 'dmarc'

// Who serves https://<domain>/.well-known/nostr.json: this server, which the
// domain's A record points to, or the owner's own website.
export type Nip05Host = 'server' | 'owner'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface RecordCheck {
  status: CheckStatus
  found: string[]
}

// A DNS record to publish, or the NIP-05 entry the owner's website lists.
export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT' | 'A' | 'NIP-05'
  name: string
  value: string
  priority?: number
  required: boolean
  check: RecordCheck | null
}

// A record the server itself needs, checked when the admin overview loads.
export interface ServerRecord {
  id: 'host' | 'ptr' | 'spf' | 'nostr'
  type: 'A' | 'PTR' | 'TXT'
  name: string
  value: string
  check: RecordCheck
}

export interface Domain {
  domain: string
  // The domain's own key, served as _smtp@<domain>, and who holds its private key.
  bridgePubkey: string
  bridgeSigner: 'server' | 'bunker'
  verifiedAt: string | null
  // Set while the admin of the server keeps the domain out of service.
  suspendedAt: string | null
  checkedAt: string | null
  blossomServers: string[]
  nip05: Nip05Host
  // Any key may create addresses on it for itself.
  shared: boolean
  // Mail to an address it does not know creates that address for the owner.
  catchAll: boolean
  createdAt: string
  records: DnsRecord[]
  // Sent to abuse@ since this key owns the domain.
  abuseReports: AbuseReport[]
}

// Mail sent to abuse@ of a domain, kept on the server.
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

export interface DomainList {
  domains: Domain[]
  // Whether this key may connect a new domain.
  canClaim: boolean
  // The domains of other keys where this one creates addresses for itself, and those it created.
  sharedDomains: string[]
  addresses: Address[]
  quotas: Quotas
  usage: QuotaUsage
}

export type QuotaName = 'addresses' | 'addressesPerHour' | 'pendingDomains' | 'recipientsPerDay' | 'keysPerAddress'

export const QUOTA_NAMES: QuotaName[] = [
  'addresses',
  'addressesPerHour',
  'pendingDomains',
  'recipientsPerDay',
  'keysPerAddress',
]

// What a key may do, null for no limit. The admins have none.
export type Quotas = Record<QuotaName, number | null>

// What a key uses of its quotas: the addresses it holds, on every domain.
export interface QuotaUsage {
  addresses: number
}

// The quotas an admin gave one key instead of the server's. A quota left out is the server's.
export interface KeyQuotas {
  pubkey: string
  quotas: Partial<Quotas>
  updatedAt: string
}

export interface Address {
  domain: string
  localPart: string
  address: string
  // Each one gets the mail and sends from the address. NIP-05 shows none of them when there are several.
  pubkeys: string[]
  // The owner of the domain, or the key that created it on a shared domain.
  createdBy: string
  // NIP-05 does not show which key it reaches.
  private: boolean
  // Mail to it is taken and dropped, without the sender knowing. It still sends.
  enabled: boolean
  createdAt: string
}

// Left out, an address is public and enabled.
export type AddressSettings = Partial<Pick<Address, 'private' | 'enabled'>>

// Nothing creates it again until the owner of the domain allows it.
export interface DeletedAddress {
  domain: string
  localPart: string
  address: string
  deletedAt: string
}

export interface AddressList {
  addresses: Address[]
  deletedAddresses: DeletedAddress[]
}

// A claim of any key, as an admin of the server sees it.
export interface AdminDomain {
  domain: string
  pubkey: string
  verifiedAt: string | null
  checkedAt: string | null
  createdAt: string
  shared: boolean
  addressCount: number
  checks: Record<RecordId, RecordCheck> | null
}

export interface Suspension {
  domain: string
  suspendedAt: string
}

// A key an admin lets connect domains.
export interface AllowedKey {
  pubkey: string
  allowedAt: string
}

export interface ServerSettings {
  // Any key connects domains, so the allowed keys do not matter.
  openRegistration: boolean
  maxMessageBytes: number
  // Uploads to the server's Blossom server stop once its blobs reach this size together.
  maxBlobStorageBytes: number
  // Given to new domains for their large mail.
  blossomServers: string[]
  // Where the lists of other keys are looked up.
  indexerRelays: string[]
  quotas: Quotas
}

// The quotas left out keep their value too.
export type SettingsChanges = Partial<Omit<ServerSettings, 'quotas'>> & { quotas?: Partial<Quotas> }

export interface AdminOverview {
  domains: AdminDomain[]
  suspensions: Suspension[]
  allowedKeys: AllowedKey[]
  keyQuotas: KeyQuotas[]
  settings: ServerSettings
  abuseReports: AbuseReport[]
  serverRecords: ServerRecord[]
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
  }
}

export type Api = ReturnType<typeof createApi>

type Fetch = (url: string, init: RequestInit) => Promise<Response>

// The API is served on the same origin as the site, so the URL signed for
// NIP-98 is the one the server sees.
export function createApi(
  signer: Signer,
  origin = window.location.origin,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
) {
  async function send(method: string, path: string, payload?: Record<string, unknown>): Promise<Response> {
    const url = origin + path
    // With a payload, NIP-98 signs the hash of the exact JSON sent.
    const authorization = await getToken(url, method, (event) => signer.signEvent(event), true, payload)
    const response = await fetchImpl(
      url,
      payload
        ? {
            method,
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }
        : { method, headers: { authorization } },
    )
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new ApiError(body?.error ?? 'http_error', response.status)
    }

    return response
  }

  async function call(method: string, path: string, payload?: Record<string, unknown>) {
    const response = await send(method, path, payload)
    return response.status === 204 ? null : response.json()
  }

  const domainPath = (name: string) => `/domains/${encodeURIComponent(name)}`
  const addressPath = (name: string, localPart: string) =>
    `${domainPath(name)}/addresses/${encodeURIComponent(localPart)}`
  const createdAddressPath = (name: string, localPart: string) =>
    `/addresses/${encodeURIComponent(name)}/${encodeURIComponent(localPart)}`

  return {
    listDomains: (): Promise<DomainList> => call('GET', '/domains'),
    getDomain: async (name: string): Promise<Domain> => (await call('GET', domainPath(name))).domain,
    connectDomain: async (name: string): Promise<Domain> => (await call('PUT', domainPath(name))).domain,
    checkDomain: async (name: string): Promise<Domain> => (await call('POST', `${domainPath(name)}/check`)).domain,
    // Checks the domain again, since the NIP-05 check depends on who serves it.
    setNip05Host: async (name: string, nip05: Nip05Host): Promise<Domain> =>
      (await call('PUT', `${domainPath(name)}/nip05`, { nip05 })).domain,
    setShared: async (name: string, shared: boolean): Promise<Domain> =>
      (await call('PUT', `${domainPath(name)}/shared`, { shared })).domain,
    setCatchAll: async (name: string, catchAll: boolean): Promise<Domain> =>
      (await call('PUT', `${domainPath(name)}/catch-all`, { catchAll })).domain,
    removeDomain: async (name: string): Promise<void> => {
      await call('DELETE', domainPath(name))
    },
    domainKey: async (name: string): Promise<string> => (await call('GET', `${domainPath(name)}/key`)).nsec,
    replaceDomainKey: async (name: string, key: { nsec: string } | { bunker: string }): Promise<Domain> =>
      (await call('PUT', `${domainPath(name)}/key`, key)).domain,
    listAddresses: (name: string): Promise<AddressList> => call('GET', `${domainPath(name)}/addresses`),
    putAddress: async (
      name: string,
      localPart: string,
      pubkeys: string[],
      settings: AddressSettings,
    ): Promise<Address> => (await call('PUT', addressPath(name, localPart), { pubkeys, ...settings })).address,
    removeAddress: async (name: string, localPart: string): Promise<void> => {
      await call('DELETE', addressPath(name, localPart))
    },
    // Without a local part, every deleted address of the domain.
    allowDeletedAddresses: async (name: string, localPart?: string): Promise<void> => {
      const path = `${domainPath(name)}/deleted-addresses`
      await call('DELETE', localPart === undefined ? path : `${path}/${encodeURIComponent(localPart)}`)
    },
    // An address on a shared domain, delivered to the signing key.
    putCreatedAddress: async (name: string, localPart: string, settings: AddressSettings): Promise<Address> =>
      (await call('PUT', createdAddressPath(name, localPart), settings)).address,
    removeCreatedAddress: async (name: string, localPart: string): Promise<void> => {
      await call('DELETE', createdAddressPath(name, localPart))
    },
    abuseMessage: async (name: string, id: number): Promise<Blob> =>
      (await send('GET', `${domainPath(name)}/abuse-reports/${id}`)).blob(),
    // The admins keep the reports the owner deletes, and the other way around.
    deleteAbuseReport: async (name: string, id: number): Promise<void> => {
      await call('DELETE', `${domainPath(name)}/abuse-reports/${id}`)
    },
    adminOverview: (): Promise<AdminOverview> => call('GET', '/admin/domains'),
    adminAbuseMessage: async (id: number): Promise<Blob> => (await send('GET', `/admin/abuse-reports/${id}`)).blob(),
    adminDeleteAbuseReport: async (id: number): Promise<void> => {
      await call('DELETE', `/admin/abuse-reports/${id}`)
    },
    suspendDomain: async (name: string): Promise<Suspension> =>
      (await call('PUT', `/admin${domainPath(name)}/suspension`)).suspension,
    liftSuspension: async (name: string): Promise<void> => {
      await call('DELETE', `/admin${domainPath(name)}/suspension`)
    },
    allowKey: async (key: string): Promise<AllowedKey> =>
      (await call('PUT', `/admin/allowed-keys/${encodeURIComponent(key)}`)).allowedKey,
    disallowKey: async (pubkey: string): Promise<void> => {
      await call('DELETE', `/admin/allowed-keys/${pubkey}`)
    },
    // The settings left out keep their value.
    updateSettings: async (changes: SettingsChanges): Promise<ServerSettings> =>
      (await call('PATCH', '/admin/settings', changes)).settings,
    // Replaces the quotas the key had of its own.
    putKeyQuotas: async (key: string, quotas: Partial<Quotas>): Promise<KeyQuotas> =>
      (await call('PUT', `/admin/key-quotas/${encodeURIComponent(key)}`, { quotas })).keyQuotas,
    removeKeyQuotas: async (pubkey: string): Promise<void> => {
      await call('DELETE', `/admin/key-quotas/${pubkey}`)
    },
  }
}
