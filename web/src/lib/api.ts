import { getToken } from 'nostr-tools/nip98'
import type { Signer } from './signer'

export type RecordId = 'ownership' | 'mx' | 'https' | 'spf' | 'dkim' | 'dmarc'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface RecordCheck {
  status: CheckStatus
  found: string[]
}

export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT' | 'A'
  name: string
  value: string
  priority?: number
  required: boolean
  check: RecordCheck | null
}

// A record the server itself needs, checked when the admin overview loads.
export interface ServerRecord {
  id: 'host' | 'ptr' | 'spf'
  type: 'A' | 'PTR' | 'TXT'
  name: string
  value: string
  check: RecordCheck
}

export interface Domain {
  domain: string
  // The domain's own key, served as _smtp@<domain>.
  bridgePubkey: string
  verifiedAt: string | null
  // Set while the admin of the server keeps the domain out of service.
  suspendedAt: string | null
  checkedAt: string | null
  blossomServers: string[]
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

export interface Address {
  localPart: string
  address: string
  pubkey: string
  createdAt: string
}

// A claim of any key, as an admin of the server sees it.
export interface AdminDomain {
  domain: string
  pubkey: string
  verifiedAt: string | null
  checkedAt: string | null
  createdAt: string
  addressCount: number
  checks: Record<RecordId, RecordCheck> | null
}

export interface Suspension {
  domain: string
  suspendedAt: string
}

export interface AdminOverview {
  domains: AdminDomain[]
  suspensions: Suspension[]
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

  return {
    listDomains: async (): Promise<Domain[]> => (await call('GET', '/domains')).domains,
    getDomain: async (name: string): Promise<Domain> => (await call('GET', domainPath(name))).domain,
    connectDomain: async (name: string): Promise<Domain> => (await call('PUT', domainPath(name))).domain,
    checkDomain: async (name: string): Promise<Domain> => (await call('POST', `${domainPath(name)}/check`)).domain,
    removeDomain: async (name: string): Promise<void> => {
      await call('DELETE', domainPath(name))
    },
    domainKey: async (name: string): Promise<string> => (await call('GET', `${domainPath(name)}/key`)).nsec,
    replaceDomainKey: async (name: string, nsec: string): Promise<Domain> =>
      (await call('PUT', `${domainPath(name)}/key`, { nsec })).domain,
    listAddresses: async (name: string): Promise<Address[]> =>
      (await call('GET', `${domainPath(name)}/addresses`)).addresses,
    putAddress: async (name: string, localPart: string, pubkey: string): Promise<Address> =>
      (await call('PUT', addressPath(name, localPart), { pubkey })).address,
    removeAddress: async (name: string, localPart: string): Promise<void> => {
      await call('DELETE', addressPath(name, localPart))
    },
    abuseMessage: async (name: string, id: number): Promise<Blob> =>
      (await send('GET', `${domainPath(name)}/abuse-reports/${id}`)).blob(),
    adminOverview: (): Promise<AdminOverview> => call('GET', '/admin/domains'),
    adminAbuseMessage: async (id: number): Promise<Blob> => (await send('GET', `/admin/abuse-reports/${id}`)).blob(),
    suspendDomain: async (name: string): Promise<Suspension> =>
      (await call('PUT', `/admin${domainPath(name)}/suspension`)).suspension,
    liftSuspension: async (name: string): Promise<void> => {
      await call('DELETE', `/admin${domainPath(name)}/suspension`)
    },
  }
}
