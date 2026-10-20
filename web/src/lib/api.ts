import { getToken } from 'nostr-tools/nip98'
import type { Signer } from './signer'

export type RecordId = 'ownership' | 'mx' | 'spf' | 'dkim' | 'dmarc'

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'error'

export interface DnsRecord {
  id: RecordId
  type: 'MX' | 'TXT'
  name: string
  value: string
  priority?: number
  required: boolean
  check: { status: CheckStatus; found: string[] } | null
}

export interface Domain {
  domain: string
  verifiedAt: string | null
  checkedAt: string | null
  blossomServers: string[]
  createdAt: string
  records: DnsRecord[]
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
  async function call(method: string, path: string) {
    const url = origin + path
    const authorization = await getToken(url, method, (event) => signer.signEvent(event), true)
    const response = await fetchImpl(url, { method, headers: { authorization } })
    const body = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(body?.error ?? 'http_error', response.status)

    return body
  }

  const domainPath = (name: string) => `/domains/${encodeURIComponent(name)}`

  return {
    listDomains: async (): Promise<Domain[]> => (await call('GET', '/domains')).domains,
    connectDomain: async (name: string): Promise<Domain> => (await call('PUT', domainPath(name))).domain,
    checkDomain: async (name: string): Promise<Domain> => (await call('POST', `${domainPath(name)}/check`)).domain,
    removeDomain: async (name: string): Promise<void> => {
      await call('DELETE', domainPath(name))
    },
  }
}
