import { normalizeBlossomUrl } from './blossom.js'
import { normalizeRelayUrl } from './nostr.js'
import { parseQuotas } from './quotas.js'
import type { DomainRepository, Quotas, RetiredRelays, ServerSettings, StoredSettings } from './types.js'

// Clients that have not read the new kind 10050 of a domain key still send to the relays it listed.
const RETIRED_RELAY_MS = 7 * 24 * 3600_000
// RFC 5321 4.5.3.1.7: a server accepts messages of 64K octets at least.
const SMALLEST_SIZE_LIMIT = 64 * 1024
const LARGEST_SIZE_LIMIT = 1024 * 1024 * 1024

const URL_SETTINGS = [
  ['blossomServers', normalizeBlossomUrl, 'invalid_blossom_servers'],
  ['domainRelays', normalizeRelayUrl, 'invalid_domain_relays'],
  ['indexerRelays', normalizeRelayUrl, 'invalid_indexer_relays'],
] as const

// The quotas left out keep their value.
export type SettingsChanges = Partial<Omit<ServerSettings, 'quotas'>> & { quotas?: Partial<Quotas> }

// The settings the admins change from /admin, kept in memory: every change goes through `update`.
export class SettingsStore {
  constructor(
    private readonly repo: DomainRepository,
    private stored: StoredSettings,
  ) {}

  static async load(repo: DomainRepository): Promise<SettingsStore> {
    return new SettingsStore(repo, await repo.findSettings())
  }

  get current(): ServerSettings {
    const { retiredDomainRelays: _, ...settings } = this.stored
    return settings
  }

  async update(changes: SettingsChanges, now = Date.now()): Promise<ServerSettings> {
    const next = { ...this.stored, ...changes, quotas: { ...this.stored.quotas, ...changes.quotas } }
    const retired: RetiredRelays = Object.fromEntries(
      Object.entries(this.stored.retiredDomainRelays).filter(
        ([relay, until]) => Date.parse(until) > now && !next.domainRelays.includes(relay),
      ),
    )
    const until = new Date(now + RETIRED_RELAY_MS).toISOString()
    for (const relay of this.stored.domainRelays) {
      if (!next.domainRelays.includes(relay)) retired[relay] = until
    }

    const stored = { ...next, retiredDomainRelays: retired }
    await this.repo.updateSettings(stored)
    this.stored = stored
    return this.current
  }

  // Where the outbox listens: the domain relays, and those taken off them lately.
  outboxRelays(now = Date.now()): string[] {
    const retired = Object.entries(this.stored.retiredDomainRelays)
      .filter(([, until]) => Date.parse(until) > now)
      .map(([relay]) => relay)
    return [...new Set([...this.stored.domainRelays, ...retired])]
  }
}

// Returns the changes an admin asked for, or the error code of the first invalid one.
export function parseSettingsChanges(body: unknown): { changes: SettingsChanges } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_settings' }

  const input = body as Record<string, unknown>
  const changes: SettingsChanges = {}
  if ('openRegistration' in input) {
    if (typeof input.openRegistration !== 'boolean') return { error: 'invalid_open_registration' }
    changes.openRegistration = input.openRegistration
  }
  if ('maxMessageBytes' in input) {
    const bytes = input.maxMessageBytes
    if (
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes < SMALLEST_SIZE_LIMIT ||
      bytes > LARGEST_SIZE_LIMIT
    ) {
      return { error: 'invalid_max_message_bytes' }
    }
    changes.maxMessageBytes = bytes
  }
  for (const [name, normalize, error] of URL_SETTINGS) {
    if (!(name in input)) continue

    const value = input[name]
    const urls = Array.isArray(value) ? value.map((url) => (typeof url === 'string' ? normalize(url) : null)) : []
    if (!urls.length || urls.includes(null)) return { error }
    changes[name] = [...new Set(urls as string[])]
  }
  if ('quotas' in input) {
    const quotas = parseQuotas(input.quotas)
    if (!quotas) return { error: 'invalid_quotas' }
    changes.quotas = quotas
  }

  return { changes }
}
