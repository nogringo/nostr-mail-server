import { Resolver } from 'node:dns/promises'
import type { DNSResolver } from 'mailauth'
import { normalizeHostname } from './domain.js'
import type { DnsLookup, MxRecord } from './types.js'

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA'])

export function createDnsLookup(servers: string[] = []): DnsLookup {
  const resolver = createResolver(servers)

  return {
    txt: async (name) => (await orEmpty(resolver.resolveTxt(name))).map((chunks) => chunks.join('')),
    mx: (name) => orEmpty(resolver.resolveMx(name)),
    addresses: async (name) => {
      const [ipv4, ipv6] = await Promise.all([orEmpty(resolver.resolve4(name)), orEmpty(resolver.resolve6(name))])
      return [...ipv4, ...ipv6]
    },
  }
}

// A domain that cannot receive mail: it does not exist, or says so with a null MX.
export class UndeliverableDomain extends Error {}

export function createExchangerLookup(servers: string[] = []): (domain: string) => Promise<string[]> {
  const resolver = createResolver(servers)
  return (domain) => findExchangers(domain, (name) => resolver.resolveMx(name))
}

// RFC 5321 5.1: the MX hosts in order of preference, or the domain itself when
// it has none. RFC 7505: a single empty exchange means the domain takes no mail.
export async function findExchangers(
  domain: string,
  resolveMx: (name: string) => Promise<MxRecord[]>,
): Promise<string[]> {
  const records = await resolveMx(domain).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENODATA') return []
    if (error.code === 'ENOTFOUND') throw new UndeliverableDomain(`${domain} does not exist`)
    throw error
  })
  if (!records.length) return [domain]

  const hosts = records.sort((a, b) => a.priority - b.priority).map((record) => normalizeHostname(record.exchange))
  if (hosts.every((host) => !host)) throw new UndeliverableDomain(`${domain} does not accept mail`)
  return hosts.filter(Boolean)
}

// mailauth expects the answers and errors of dns.promises.resolve, MX objects included.
export function createAuthResolver(servers: string[] = []): DNSResolver {
  const resolver = createResolver(servers)
  return (name, rrtype) => resolver.resolve(name, rrtype) as ReturnType<DNSResolver>
}

function createResolver(servers: string[]): Resolver {
  const resolver = new Resolver({ timeout: 5000, tries: 2 })
  if (servers.length) resolver.setServers(servers)
  return resolver
}

async function orEmpty<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query
  } catch (error) {
    if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return []
    throw error
  }
}
