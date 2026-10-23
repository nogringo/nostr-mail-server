import type { SettingsStore } from './settings.js'
import type { Domain, DomainRepository, PeriodQuota, QuotaName, Quotas } from './types.js'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

export const QUOTA_NAMES: QuotaName[] = ['addresses', 'addressesPerHour', 'pendingDomains', 'recipientsPerDay']

export const NO_QUOTAS: Quotas = {
  addresses: null,
  addressesPerHour: null,
  pendingDomains: null,
  recipientsPerDay: null,
}

// Why a key creates no address for now.
export type AddressRefusal = 'address_quota' | 'address_rate_quota'

// What a key uses of the quotas that count its own actions.
export interface QuotaUsage {
  addresses: number
}

// Applies the quotas of the keys. The admins have none, and a key an admin gave quotas of its own takes them
// instead of the server's.
export class QuotaKeeper {
  private prunedAt = 0

  constructor(
    private readonly repo: DomainRepository,
    private readonly settings: SettingsStore,
    private readonly admins: string[],
  ) {}

  async of(pubkey: string): Promise<Quotas> {
    if (this.admins.includes(pubkey)) return NO_QUOTAS
    return { ...this.settings.current.quotas, ...(await this.repo.findKeyQuotas(pubkey))?.quotas }
  }

  async usage(pubkey: string): Promise<QuotaUsage> {
    return { addresses: await this.repo.countCreatedAddresses(pubkey) }
  }

  async refuseAddress(pubkey: string): Promise<AddressRefusal | null> {
    const { addresses, addressesPerHour } = await this.of(pubkey)
    if (addresses !== null && (await this.repo.countCreatedAddresses(pubkey)) >= addresses) return 'address_quota'
    if (addressesPerHour !== null && (await this.used('addressesPerHour', pubkey, HOUR_MS)) >= addressesPerHour) {
      return 'address_rate_quota'
    }
    return null
  }

  async recordAddress(pubkey: string): Promise<void> {
    await this.record('addressesPerHour', pubkey, 1)
  }

  async refusesPendingDomain(pubkey: string): Promise<boolean> {
    const { pendingDomains } = await this.of(pubkey)
    if (pendingDomains === null) return false

    const pending = (await this.repo.listDomains(pubkey)).filter((domain) => !domain.verifiedAt)
    return pending.length >= pendingDomains
  }

  // The daily quota a mail to this many recipients would take the domain over, or null.
  async exceededRecipients(domain: Domain, recipients: number): Promise<number | null> {
    const { recipientsPerDay } = await this.of(domain.pubkey)
    if (recipientsPerDay === null) return null

    const used = await this.used('recipientsPerDay', domain.domain, DAY_MS)
    return used + recipients > recipientsPerDay ? recipientsPerDay : null
  }

  async recordRecipients(domain: Domain, recipients: number): Promise<void> {
    await this.record('recipientsPerDay', domain.domain, recipients)
  }

  private used(quota: PeriodQuota, subject: string, periodMs: number): Promise<number> {
    return this.repo.countQuotaUsage(quota, subject, new Date(Date.now() - periodMs))
  }

  // Counted even without a limit, so that a limit set later applies at once.
  private async record(quota: PeriodQuota, subject: string, amount: number): Promise<void> {
    await this.repo.addQuotaUsage(quota, subject, amount)
    if (Date.now() - this.prunedAt < HOUR_MS) return

    this.prunedAt = Date.now()
    await this.repo.pruneQuotaUsage(new Date(Date.now() - DAY_MS))
  }
}

// The quotas given, each a whole number or null for no limit, or null when one is unknown or invalid.
export function parseQuotas(value: unknown): Partial<Quotas> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const quotas: Partial<Quotas> = {}
  for (const [name, limit] of Object.entries(value)) {
    if (!QUOTA_NAMES.includes(name as QuotaName)) return null
    if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 0)) return null
    quotas[name as QuotaName] = limit
  }
  return quotas
}
