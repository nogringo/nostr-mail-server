import { Resolver } from 'node:dns/promises'
import type { DNSResolver } from 'mailauth'
import type { DnsLookup } from './types.js'

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA'])

export function createDnsLookup(servers: string[] = []): DnsLookup {
  const resolver = createResolver(servers)

  return {
    txt: async (name) => (await orEmpty(resolver.resolveTxt(name))).map((chunks) => chunks.join('')),
    mx: (name) => orEmpty(resolver.resolveMx(name)),
  }
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
