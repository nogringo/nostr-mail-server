import { isIP } from 'node:net'
import type { SettingsStore } from './settings.js'
import type { Domain, DomainRepository, PeriodQuota, QuotaName, Quotas } from './types.js'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

export const QUOTA_NAMES: QuotaName[] = [
  'addresses',
  'addressesPerHour',
  'pendingDomains',
  'recipientsPerDay',
  'keysPerAddress',
  'addressesPerIpPerHour',
]

export const NO_QUOTAS: Quotas = {
  addresses: null,
  addressesPerHour: null,
  pendingDomains: null,
  recipientsPerDay: null,
  keysPerAddress: null,
  addressesPerIpPerHour: null,
}

// Why a key creates no address for now.
export type AddressRefusal = 'address_quota' | 'address_rate_quota' | 'address_ip_quota'

// What a key uses of the quotas that count its own actions.
export interface QuotaUsage {
  addresses: number
}

// Applies the quotas of the keys. The admins have none, and a key an admin gave quotas of its own takes them
// instead of the server's.
export class QuotaKeeper {
  private prunedAt = 0
  // When addresses were created from each IP subject over the last hour. Kept in memory only, so that no
  // IP address is ever stored: a restart forgets them.
  private readonly ipCreations = new Map<string, number[]>()
  private ipPrunedAt = 0

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

  // The IP address is the client's, unknown when the catch-all creates the address.
  async refuseAddress(pubkey: string, ip?: string): Promise<AddressRefusal | null> {
    const { addresses, addressesPerHour, addressesPerIpPerHour } = await this.of(pubkey)
    if (addresses !== null && (await this.repo.countCreatedAddresses(pubkey)) >= addresses) return 'address_quota'
    if (addressesPerHour !== null && (await this.used('addressesPerHour', pubkey, HOUR_MS)) >= addressesPerHour) {
      return 'address_rate_quota'
    }
    if (addressesPerIpPerHour !== null && ip && this.createdFrom(ip) >= addressesPerIpPerHour) return 'address_ip_quota'
    return null
  }

  async recordAddress(pubkey: string, ip?: string): Promise<void> {
    if (ip) this.recordIp(ip)
    await this.record('addressesPerHour', pubkey, 1)
  }

  // One key is always allowed.
  async refusesKeys(pubkey: string, keys: number): Promise<boolean> {
    const { keysPerAddress } = await this.of(pubkey)
    return keysPerAddress !== null && keys > Math.max(keysPerAddress, 1)
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

  private createdFrom(ip: string): number {
    const since = Date.now() - HOUR_MS
    return this.ipCreations.get(ipSubject(ip))?.filter((at) => at > since).length ?? 0
  }

  private recordIp(ip: string): void {
    const now = Date.now()
    const subject = ipSubject(ip)
    const recent = (this.ipCreations.get(subject) ?? []).filter((at) => at > now - HOUR_MS)
    this.ipCreations.set(subject, [...recent, now])
    if (now - this.ipPrunedAt < HOUR_MS) return

    this.ipPrunedAt = now
    for (const [stale, times] of this.ipCreations) {
      if (times.every((at) => at <= now - HOUR_MS)) this.ipCreations.delete(stale)
    }
  }
}

// What an IP address is counted as: the IPv4 address itself, or the /64 of an IPv6 address, the block one
// subscriber usually gets.
export function ipSubject(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIP(ip) !== 6) return ip

  // An IPv4 address at the end stands for the last two groups.
  const groups = (part = '') =>
    part ? part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : []
  const [head, tail] = ip.split('::')
  const start = groups(head)
  const end = groups(tail)
  const full = [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
  return `${full
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`
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
