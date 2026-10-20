import { Resolver } from 'node:dns/promises'
import type { DnsLookup } from './types.js'

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA'])

export function createDnsLookup(servers: string[] = []): DnsLookup {
  const resolver = new Resolver({ timeout: 5000, tries: 2 })
  if (servers.length) resolver.setServers(servers)

  return {
    txt: async (name) => (await orEmpty(resolver.resolveTxt(name))).map((chunks) => chunks.join('')),
    mx: (name) => orEmpty(resolver.resolveMx(name)),
  }
}

async function orEmpty<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query
  } catch (error) {
    if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return []
    throw error
  }
}
