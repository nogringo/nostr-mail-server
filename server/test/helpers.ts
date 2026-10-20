import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NIP98_KIND } from '../src/nip98.js'
import type { DnsLookup, Domain, DomainChecks, DomainConfig, DomainRepository, MxRecord, NewDomain } from '../src/types.js'

export const API_HOST = 'app.example.org'

export const domainConfig: DomainConfig = {
  mxHost: 'mx.example.org',
  spfInclude: '_spf.example.org',
  dkimSelector: 'nostrmail',
}

export class MemoryDomainRepository implements DomainRepository {
  readonly domains = new Map<string, Domain>()
  fail = false

  async findDomain(domain: string, pubkey: string): Promise<Domain | null> {
    this.assertAvailable()
    return this.domains.get(key(domain, pubkey)) ?? null
  }

  async listDomains(pubkey: string): Promise<Domain[]> {
    this.assertAvailable()
    return [...this.domains.values()]
      .filter((domain) => domain.pubkey === pubkey)
      .sort((left, right) => left.domain.localeCompare(right.domain))
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
      for (const [claimKey, claim] of this.domains) {
        if (claim.domain === domain && claim.pubkey !== pubkey) this.domains.delete(claimKey)
      }
    }

    const now = new Date().toISOString()
    const next = { ...current, checks, checkedAt: now, verifiedAt: verified ? (current.verifiedAt ?? now) : current.verifiedAt }
    this.domains.set(key(domain, pubkey), next)
    return next
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.domains.delete(key(domain, pubkey))
  }

  private assertAvailable(): void {
    if (this.fail) throw new Error('database unavailable')
  }
}

export class FakeDns implements DnsLookup {
  readonly txtRecords = new Map<string, string[]>()
  readonly mxRecords = new Map<string, MxRecord[]>()
  readonly failing = new Set<string>()

  async txt(name: string): Promise<string[]> {
    this.assertResolvable(name)
    return this.txtRecords.get(name) ?? []
  }

  async mx(name: string): Promise<MxRecord[]> {
    this.assertResolvable(name)
    return this.mxRecords.get(name) ?? []
  }

  private assertResolvable(name: string): void {
    if (this.failing.has(name)) throw Object.assign(new Error(`queryTxt ESERVFAIL ${name}`), { code: 'ESERVFAIL' })
  }
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

function key(domain: string, pubkey: string): string {
  return `${domain}:${pubkey}`
}
