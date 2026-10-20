import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { buildApp } from '../src/app.js'
import { NIP98_KIND } from '../src/nip98.js'
import { generateKeyPair } from '../src/nostr.js'
import type {
  Address,
  DnsLookup,
  Domain,
  DomainChecks,
  DomainConfig,
  DomainRepository,
  MxRecord,
  NewAddress,
  NewDomain,
} from '../src/types.js'

export const API_HOST = 'app.example.org'

export const domainConfig: DomainConfig = {
  mxHost: 'mx.example.org',
  spfInclude: '_spf.example.org',
  dkimSelector: 'nostrmail',
}

export class MemoryDomainRepository implements DomainRepository {
  readonly domains = new Map<string, Domain>()
  readonly addresses = new Map<string, Address>()
  fail = false

  async findDomain(domain: string, pubkey: string): Promise<Domain | null> {
    this.assertAvailable()
    return this.domains.get(key(domain, pubkey)) ?? null
  }

  async findVerifiedDomain(domain: string): Promise<Domain | null> {
    this.assertAvailable()
    return [...this.domains.values()].find((claim) => claim.domain === domain && claim.verifiedAt !== null) ?? null
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
    return next
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    this.assertAvailable()
    return this.dropClaim(domain, pubkey)
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

  async putAddress(input: NewAddress): Promise<Address> {
    this.assertAvailable()
    const existing = this.addresses.get(key(input.domain, input.localPart))
    const address = { ...input, createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.addresses.set(key(input.domain, input.localPart), address)
    return address
  }

  async deleteAddress(domain: string, localPart: string): Promise<boolean> {
    this.assertAvailable()
    return this.addresses.delete(key(domain, localPart))
  }

  // Mirrors the foreign key: the addresses of a claim go away with it.
  private dropClaim(domain: string, pubkey: string): boolean {
    for (const [addressKey, address] of this.addresses) {
      if (address.domain === domain && address.ownerPubkey === pubkey) this.addresses.delete(addressKey)
    }
    return this.domains.delete(key(domain, pubkey))
  }

  private assertAvailable(): void {
    if (this.fail) throw new Error('database unavailable')
  }
}

const OWNERSHIP_ONLY: DomainChecks = {
  ownership: { status: 'ok', found: [] },
  mx: { status: 'missing', found: [] },
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
  }
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

export type App = ReturnType<typeof buildApp>

export function request(
  app: App,
  user: Signer,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
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
