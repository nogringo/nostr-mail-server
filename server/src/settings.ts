import { normalizeBlossomUrl } from './blossom.js'
import { normalizeRelayUrl } from './nostr.js'
import { parseQuotas } from './quotas.js'
import type { DomainRepository, Quotas, RetiredRelays, ServerSettings, StoredSettings } from './types.js'

// Clients that have not read the new kind 10050 of a domain key still send to the relays it listed.
const RETIRED_RELAY_MS = 7 * 24 * 3600_000
// RFC 5321 4.5.3.1.7: a server accepts messages of 64K octets at least.
const SMALLEST_SIZE_LIMIT = 64 * 1024
const LARGEST_SIZE_LIMIT = 1024 * 1024 * 1024
const LARGEST_STORAGE_LIMIT = 1024 * LARGEST_SIZE_LIMIT

const SIZE_SETTINGS = [
  ['maxMessageBytes', LARGEST_SIZE_LIMIT, 'invalid_max_message_bytes'],
  ['maxBlobStorageBytes', LARGEST_STORAGE_LIMIT, 'invalid_max_blob_storage_bytes'],
] as const

const URL_SETTINGS = [
  ['blossomServers', normalizeBlossomUrl, 'invalid_blossom_servers'],
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
    const { domainRelays: _, domainBlossomServer: __, retiredDomainRelays: ___, ...settings } = this.stored
    return settings
  }

  async update(changes: SettingsChanges): Promise<ServerSettings> {
    await this.store({ ...this.stored, ...changes, quotas: { ...this.stored.quotas, ...changes.quotas } })
    return this.current
  }

  // Makes the server's relay and Blossom server the ones the domain keys announce. Returns whether they
  // announced others: the outbox keeps listening to the relays a while.
  async announce(relay: string, blossomServer: string, now = Date.now()): Promise<boolean> {
    const before = this.stored.domainRelays
    if (before.length === 1 && before[0] === relay && this.stored.domainBlossomServer === blossomServer) return false

    const retired: RetiredRelays = Object.fromEntries(
      Object.entries(this.stored.retiredDomainRelays).filter(
        ([retiredRelay, until]) => Date.parse(until) > now && retiredRelay !== relay,
      ),
    )
    const until = new Date(now + RETIRED_RELAY_MS).toISOString()
    for (const announced of before) {
      if (announced !== relay) retired[announced] = until
    }

    await this.store({
      ...this.stored,
      domainRelays: [relay],
      domainBlossomServer: blossomServer,
      retiredDomainRelays: retired,
    })
    return true
  }

  // Where the outbox listens: the relays the domain keys announced lately. Their mail now reaches the
  // server's relay directly.
  outboxRelays(now = Date.now()): string[] {
    return Object.entries(this.stored.retiredDomainRelays)
      .filter(([, until]) => Date.parse(until) > now)
      .map(([relay]) => relay)
  }

  private async store(stored: StoredSettings): Promise<void> {
    await this.repo.updateSettings(stored)
    this.stored = stored
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
  for (const [name, largest, error] of SIZE_SETTINGS) {
    if (!(name in input)) continue

    const bytes = input[name]
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < SMALLEST_SIZE_LIMIT || bytes > largest) {
      return { error }
    }
    changes[name] = bytes
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
