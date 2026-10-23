import type { NostrEvent } from 'nostr-tools/pure'
import pg from 'pg'
import type {
  AbuseReader,
  AbuseReport,
  Address,
  AllowedKey,
  BridgeKey,
  BunkerKey,
  DeletedAddress,
  Domain,
  DomainChecks,
  DomainRepository,
  DomainSummary,
  KeyPair,
  KeyQuotas,
  NewAbuseReport,
  NewAddress,
  NewDomain,
  NewOutboundMessage,
  Nip05Host,
  OutboundMessage,
  PeriodQuota,
  Quotas,
  RecipientOutcome,
  RetiredRelays,
  StoredSettings,
  Suspension,
} from './types.js'

const DOMAIN_COLUMNS = `
  domain, pubkey, verification_token, dkim_selector, dkim_public_key, dkim_private_key,
  bridge_pubkey, bridge_private_key, bridge_bunker, blossom_servers, nip05, shared, catch_all, checks, checked_at,
  verified_at, created_at
`

const ADDRESS_COLUMNS = 'domain, local_part, pubkey, owner_pubkey, created_by, private, enabled, created_at'

const ABUSE_REPORT_COLUMNS = 'id, domain, mail_from, header_from, subject, octet_length(message) as size, received_at'

const IN_SERVICE = 'verified_at is not null and domain not in (select domain from suspended_domains)'

interface DomainRow {
  domain: string
  pubkey: string
  verification_token: string
  dkim_selector: string
  dkim_public_key: string
  dkim_private_key: string
  bridge_pubkey: string
  bridge_private_key: string | null
  bridge_bunker: BunkerKey | null
  blossom_servers: string[]
  nip05: Nip05Host
  shared: boolean
  catch_all: boolean
  checks: DomainChecks | null
  checked_at: Date | null
  verified_at: Date | null
  created_at: Date
}

interface AddressRow {
  domain: string
  local_part: string
  pubkey: string
  owner_pubkey: string
  created_by: string
  private: boolean
  enabled: boolean
  created_at: Date
}

interface DeletedAddressRow {
  domain: string
  local_part: string
  deleted_at: Date
}

interface SuspensionRow {
  domain: string
  suspended_at: Date
}

interface AllowedKeyRow {
  pubkey: string
  allowed_at: Date
}

interface KeyQuotasRow {
  pubkey: string
  quotas: Partial<Quotas>
  updated_at: Date
}

interface SettingsRow {
  open_registration: boolean
  max_message_bytes: number
  blossom_servers: string[]
  domain_relays: string[]
  indexer_relays: string[]
  quotas: Quotas
  retired_domain_relays: RetiredRelays
}

interface AbuseReportRow {
  id: number
  domain: string
  mail_from: string
  header_from: string
  subject: string
  size: number
  received_at: Date
}

interface OutboundMessageRow {
  wrap_id: string
  bridge_pubkey: string
  wrap: NostrEvent
  received_at: Date
  recipients: { address: string; attempts: number }[]
}

export class PgDomainRepository implements DomainRepository {
  private readonly pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl })
  }

  async findDomain(domain: string, pubkey: string): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where domain = $1 and pubkey = $2`,
      [domain, pubkey],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async findVerifiedDomain(domain: string): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where domain = $1 and ${IN_SERVICE}`,
      [domain],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async findVerifiedDomainByBridgePubkey(bridgePubkey: string): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where bridge_pubkey = $1 and ${IN_SERVICE}`,
      [bridgePubkey],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async findOwnedDomain(domain: string): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where domain = $1 and verified_at is not null`,
      [domain],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async hasServedDomain(domain: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from served_domains where domain = $1', [domain])
    return (result.rowCount ?? 0) > 0
  }

  async listVerifiedDomains(): Promise<Domain[]> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where ${IN_SERVICE} order by domain asc`,
    )
    return result.rows.map(toDomain)
  }

  async listDomains(pubkey: string): Promise<Domain[]> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where pubkey = $1 order by domain asc`,
      [pubkey],
    )
    return result.rows.map(toDomain)
  }

  async listAllDomains(): Promise<DomainSummary[]> {
    const result = await this.pool.query<DomainRow & { address_count: number }>(
      `
        select ${DOMAIN_COLUMNS},
               (select count(*) from addresses a where a.domain = domains.domain and a.owner_pubkey = domains.pubkey)::int
                 as address_count
        from domains
        order by domain asc, created_at asc
      `,
    )
    return result.rows.map((row) => ({ ...toDomain(row), addressCount: row.address_count }))
  }

  async createDomain(input: NewDomain): Promise<Domain> {
    const result = await this.pool.query<DomainRow>(
      `
        insert into domains (
          domain, pubkey, verification_token, dkim_selector, dkim_public_key, dkim_private_key,
          bridge_pubkey, bridge_private_key, blossom_servers
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (domain, pubkey) do nothing
        returning ${DOMAIN_COLUMNS}
      `,
      [
        input.domain,
        input.pubkey,
        input.verificationToken,
        input.dkimSelector,
        input.dkimPublicKey,
        input.dkimPrivateKey,
        input.bridgePubkey,
        input.bridgePrivateKey,
        input.blossomServers,
      ],
    )
    if (result.rows[0]) return toDomain(result.rows[0])

    const existing = await this.findDomain(input.domain, input.pubkey)
    if (!existing) throw new Error(`Claim on ${input.domain} disappeared while being created`)
    return existing
  }

  async recordChecks(domain: string, pubkey: string, checks: DomainChecks, verified: boolean): Promise<Domain | null> {
    return this.transaction(async (client) => {
      if (verified) {
        await client.query('delete from domains where domain = $1 and pubkey <> $2', [domain, pubkey])
      }
      const result = await client.query<DomainRow>(
        `
          update domains
          set checks = $3,
              checked_at = now(),
              verified_at = case when $4::boolean then coalesce(verified_at, now()) else verified_at end
          where domain = $1 and pubkey = $2
          returning ${DOMAIN_COLUMNS}
        `,
        [domain, pubkey, JSON.stringify(checks), verified],
      )
      if (verified && result.rows[0]) {
        await client.query('insert into served_domains (domain) values ($1) on conflict (domain) do nothing', [domain])
        await purgeAbuseReports(client, domain)
      }
      return result.rows[0] ? toDomain(result.rows[0]) : null
    })
  }

  async setNip05Host(domain: string, pubkey: string, nip05: Nip05Host): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `update domains set nip05 = $3 where domain = $1 and pubkey = $2 returning ${DOMAIN_COLUMNS}`,
      [domain, pubkey, nip05],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async setShared(domain: string, pubkey: string, shared: boolean): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `update domains set shared = $3 where domain = $1 and pubkey = $2 returning ${DOMAIN_COLUMNS}`,
      [domain, pubkey, shared],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async setCatchAll(domain: string, pubkey: string, catchAll: boolean): Promise<Domain | null> {
    const result = await this.pool.query<DomainRow>(
      `update domains set catch_all = $3 where domain = $1 and pubkey = $2 returning ${DOMAIN_COLUMNS}`,
      [domain, pubkey, catchAll],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async listSharedDomains(): Promise<string[]> {
    const result = await this.pool.query<{ domain: string }>(
      `select domain from domains where shared and ${IN_SERVICE} order by domain asc`,
    )
    return result.rows.map((row) => row.domain)
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query('delete from domains where domain = $1 and pubkey = $2', [domain, pubkey])
      await purgeAbuseReports(client, domain)
      return (result.rowCount ?? 0) > 0
    })
  }

  async hasBridgeKey(bridgePubkey: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from domains where bridge_pubkey = $1', [bridgePubkey])
    return (result.rowCount ?? 0) > 0
  }

  async replaceBridgeKey(domain: string, pubkey: string, bridgeKey: BridgeKey): Promise<Domain | null> {
    return this.transaction(async (client) => {
      await client.query(
        `
          delete from outbound_messages
          where bridge_pubkey = (select bridge_pubkey from domains where domain = $1 and pubkey = $2)
            and bridge_pubkey <> $3
        `,
        [domain, pubkey, bridgeKey.bridgePubkey],
      )
      const result = await client.query<DomainRow>(
        `
          update domains set bridge_pubkey = $3, bridge_private_key = $4, bridge_bunker = $5
          where domain = $1 and pubkey = $2
          returning ${DOMAIN_COLUMNS}
        `,
        [
          domain,
          pubkey,
          bridgeKey.bridgePubkey,
          bridgeKey.bridgePrivateKey,
          bridgeKey.bridgeBunker ? JSON.stringify(bridgeKey.bridgeBunker) : null,
        ],
      )
      return result.rows[0] ? toDomain(result.rows[0]) : null
    })
  }

  async listSuspensions(): Promise<Suspension[]> {
    const result = await this.pool.query<SuspensionRow>(
      'select domain, suspended_at from suspended_domains order by domain asc',
    )
    return result.rows.map(toSuspension)
  }

  async findSuspension(domain: string): Promise<Suspension | null> {
    const result = await this.pool.query<SuspensionRow>(
      'select domain, suspended_at from suspended_domains where domain = $1',
      [domain],
    )
    return result.rows[0] ? toSuspension(result.rows[0]) : null
  }

  async suspendDomain(domain: string): Promise<Suspension> {
    await this.pool.query('insert into suspended_domains (domain) values ($1) on conflict (domain) do nothing', [
      domain,
    ])
    const suspension = await this.findSuspension(domain)
    if (!suspension) throw new Error(`The suspension of ${domain} disappeared while being created`)
    return suspension
  }

  async unsuspendDomain(domain: string): Promise<boolean> {
    const result = await this.pool.query('delete from suspended_domains where domain = $1', [domain])
    return (result.rowCount ?? 0) > 0
  }

  async listAllowedKeys(): Promise<AllowedKey[]> {
    const result = await this.pool.query<AllowedKeyRow>(
      'select pubkey, allowed_at from allowed_keys order by allowed_at asc, pubkey asc',
    )
    return result.rows.map(toAllowedKey)
  }

  async isAllowedKey(pubkey: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from allowed_keys where pubkey = $1', [pubkey])
    return (result.rowCount ?? 0) > 0
  }

  async allowKey(pubkey: string): Promise<AllowedKey> {
    await this.pool.query('insert into allowed_keys (pubkey) values ($1) on conflict (pubkey) do nothing', [pubkey])
    const result = await this.pool.query<AllowedKeyRow>(
      'select pubkey, allowed_at from allowed_keys where pubkey = $1',
      [pubkey],
    )
    if (!result.rows[0]) throw new Error(`The allowed key ${pubkey} disappeared while being created`)
    return toAllowedKey(result.rows[0])
  }

  async disallowKey(pubkey: string): Promise<boolean> {
    const result = await this.pool.query('delete from allowed_keys where pubkey = $1', [pubkey])
    return (result.rowCount ?? 0) > 0
  }

  async listKeyQuotas(): Promise<KeyQuotas[]> {
    const result = await this.pool.query<KeyQuotasRow>(
      'select pubkey, quotas, updated_at from key_quotas order by updated_at asc, pubkey asc',
    )
    return result.rows.map(toKeyQuotas)
  }

  async findKeyQuotas(pubkey: string): Promise<KeyQuotas | null> {
    const result = await this.pool.query<KeyQuotasRow>(
      'select pubkey, quotas, updated_at from key_quotas where pubkey = $1',
      [pubkey],
    )
    return result.rows[0] ? toKeyQuotas(result.rows[0]) : null
  }

  async putKeyQuotas(pubkey: string, quotas: Partial<Quotas>): Promise<KeyQuotas> {
    const result = await this.pool.query<KeyQuotasRow>(
      `
        insert into key_quotas (pubkey, quotas) values ($1, $2)
        on conflict (pubkey) do update set quotas = excluded.quotas, updated_at = now()
        returning pubkey, quotas, updated_at
      `,
      [pubkey, JSON.stringify(quotas)],
    )
    return toKeyQuotas(result.rows[0])
  }

  async deleteKeyQuotas(pubkey: string): Promise<boolean> {
    const result = await this.pool.query('delete from key_quotas where pubkey = $1', [pubkey])
    return (result.rowCount ?? 0) > 0
  }

  async addQuotaUsage(quota: PeriodQuota, subject: string, amount: number): Promise<void> {
    await this.pool.query('insert into quota_usage (quota, subject, amount) values ($1, $2, $3)', [
      quota,
      subject,
      amount,
    ])
  }

  async countQuotaUsage(quota: PeriodQuota, subject: string, since: Date): Promise<number> {
    const result = await this.pool.query<{ used: number }>(
      `
        select coalesce(sum(amount), 0)::int as used from quota_usage
        where quota = $1 and subject = $2 and used_at >= $3
      `,
      [quota, subject, since],
    )
    return result.rows[0].used
  }

  async pruneQuotaUsage(before: Date): Promise<number> {
    const result = await this.pool.query('delete from quota_usage where used_at < $1', [before])
    return result.rowCount ?? 0
  }

  async findSettings(): Promise<StoredSettings> {
    const result = await this.pool.query<SettingsRow>(
      `select open_registration, max_message_bytes, blossom_servers, domain_relays, indexer_relays, quotas,
        retired_domain_relays from server_settings`,
    )
    const row = result.rows[0]
    return {
      openRegistration: row.open_registration,
      maxMessageBytes: row.max_message_bytes,
      blossomServers: row.blossom_servers,
      domainRelays: row.domain_relays,
      indexerRelays: row.indexer_relays,
      quotas: row.quotas,
      retiredDomainRelays: row.retired_domain_relays,
    }
  }

  async updateSettings(settings: StoredSettings): Promise<void> {
    await this.pool.query(
      `update server_settings set open_registration = $1, max_message_bytes = $2, blossom_servers = $3,
        domain_relays = $4, indexer_relays = $5, quotas = $6, retired_domain_relays = $7`,
      [
        settings.openRegistration,
        settings.maxMessageBytes,
        settings.blossomServers,
        settings.domainRelays,
        settings.indexerRelays,
        JSON.stringify(settings.quotas),
        settings.retiredDomainRelays,
      ],
    )
  }

  async listAddresses(domain: string): Promise<Address[]> {
    const result = await this.pool.query<AddressRow>(
      `select ${ADDRESS_COLUMNS} from addresses where domain = $1 order by local_part asc`,
      [domain],
    )
    return result.rows.map(toAddress)
  }

  async findAddress(domain: string, localPart: string): Promise<Address | null> {
    const result = await this.pool.query<AddressRow>(
      `select ${ADDRESS_COLUMNS} from addresses where domain = $1 and local_part = $2`,
      [domain, localPart],
    )
    return result.rows[0] ? toAddress(result.rows[0]) : null
  }

  async listCreatedAddresses(createdBy: string): Promise<Address[]> {
    const result = await this.pool.query<AddressRow>(
      `
        select ${ADDRESS_COLUMNS} from addresses
        where created_by = $1 and owner_pubkey <> $1
        order by domain asc, local_part asc
      `,
      [createdBy],
    )
    return result.rows.map(toAddress)
  }

  async countCreatedAddresses(createdBy: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      'select count(*)::int as count from addresses where created_by = $1',
      [createdBy],
    )
    return result.rows[0].count
  }

  async putAddress(input: NewAddress): Promise<Address> {
    const result = await this.pool.query<AddressRow>(
      `
        insert into addresses (domain, local_part, pubkey, owner_pubkey, created_by, private, enabled)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (domain, local_part) do update
        set pubkey = excluded.pubkey, owner_pubkey = excluded.owner_pubkey, private = excluded.private,
            enabled = excluded.enabled,
            created_by = case when addresses.pubkey = excluded.pubkey then addresses.created_by
                              else excluded.created_by end
        returning ${ADDRESS_COLUMNS}
      `,
      [
        input.domain,
        input.localPart,
        input.pubkey,
        input.ownerPubkey,
        input.createdBy ?? input.ownerPubkey,
        input.private ?? false,
        input.enabled ?? true,
      ],
    )
    return toAddress(result.rows[0])
  }

  async putCreatedAddress(input: NewAddress & { createdBy: string }): Promise<Address | null> {
    const result = await this.pool.query<AddressRow>(
      `
        insert into addresses (domain, local_part, pubkey, owner_pubkey, created_by, private, enabled)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (domain, local_part) do update
        set private = excluded.private, enabled = excluded.enabled
        where addresses.created_by = excluded.created_by
        returning ${ADDRESS_COLUMNS}
      `,
      [
        input.domain,
        input.localPart,
        input.pubkey,
        input.ownerPubkey,
        input.createdBy,
        input.private ?? false,
        input.enabled ?? true,
      ],
    )
    return result.rows[0] ? toAddress(result.rows[0]) : null
  }

  async createCatchAllAddress(domain: Domain, localPart: string): Promise<Address | null> {
    // The no-op update returns the address created meanwhile, unchanged.
    const result = await this.pool.query<AddressRow>(
      `
        insert into addresses (domain, local_part, pubkey, owner_pubkey, created_by, private)
        select $1, $2, $3, $3, $3, true
        where not exists (select 1 from deleted_addresses where domain = $1 and local_part = $2)
        on conflict (domain, local_part) do update set local_part = excluded.local_part
        returning ${ADDRESS_COLUMNS}
      `,
      [domain.domain, localPart, domain.pubkey],
    )
    return result.rows[0] ? toAddress(result.rows[0]) : null
  }

  async deleteAddress(domain: string, localPart: string, createdBy?: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        with deleted as (
          delete from addresses where domain = $1 and local_part = $2 and created_by = coalesce($3, created_by)
          returning domain, local_part, owner_pubkey
        )
        insert into deleted_addresses (domain, local_part, owner_pubkey)
        select domain, local_part, owner_pubkey from deleted
        on conflict (domain, local_part) do update set owner_pubkey = excluded.owner_pubkey, deleted_at = now()
      `,
      [domain, localPart, createdBy ?? null],
    )
    return (result.rowCount ?? 0) > 0
  }

  async listDeletedAddresses(domain: string): Promise<DeletedAddress[]> {
    const result = await this.pool.query<DeletedAddressRow>(
      'select domain, local_part, deleted_at from deleted_addresses where domain = $1 order by local_part asc',
      [domain],
    )
    return result.rows.map((row) => ({
      domain: row.domain,
      localPart: row.local_part,
      deletedAt: row.deleted_at.toISOString(),
    }))
  }

  async isDeletedAddress(domain: string, localPart: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from deleted_addresses where domain = $1 and local_part = $2', [
      domain,
      localPart,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async allowDeletedAddresses(domain: string, localPart?: string): Promise<number> {
    const result = await this.pool.query(
      'delete from deleted_addresses where domain = $1 and local_part = coalesce($2, local_part)',
      [domain, localPart ?? null],
    )
    return result.rowCount ?? 0
  }

  async hasOutboundMessage(wrapId: string): Promise<boolean> {
    const result = await this.pool.query('select 1 from outbound_messages where wrap_id = $1', [wrapId])
    return (result.rowCount ?? 0) > 0
  }

  async addOutboundMessage(input: NewOutboundMessage): Promise<void> {
    await this.transaction(async (client) => {
      const queued = 'wrap' in input
      const result = await client.query(
        `
          insert into outbound_messages (wrap_id, bridge_pubkey, wrap, refusal)
          values ($1, $2, $3, $4)
          on conflict (wrap_id) do nothing
        `,
        [input.wrapId, input.bridgePubkey, queued ? JSON.stringify(input.wrap) : null, queued ? null : input.refusal],
      )
      if (!queued || result.rowCount === 0) return

      await client.query('insert into outbound_recipients (wrap_id, address) select $1, unnest($2::text[])', [
        input.wrapId,
        input.recipients,
      ])
    })
  }

  async listDueOutboundMessages(limit: number): Promise<OutboundMessage[]> {
    const result = await this.pool.query<OutboundMessageRow>(
      `
        select m.wrap_id, m.bridge_pubkey, m.wrap, m.received_at,
               json_agg(json_build_object('address', r.address, 'attempts', r.attempts) order by r.address) as recipients
        from outbound_messages m
        join outbound_recipients r on r.wrap_id = m.wrap_id
        where r.status = 'pending' and r.next_attempt_at <= now() and m.wrap is not null
        group by m.wrap_id
        order by min(r.next_attempt_at)
        limit $1
      `,
      [limit],
    )
    return result.rows.map((row) => ({
      wrapId: row.wrap_id,
      bridgePubkey: row.bridge_pubkey,
      wrap: row.wrap,
      receivedAt: row.received_at.toISOString(),
      recipients: row.recipients,
    }))
  }

  async recordOutcomes(wrapId: string, outcomes: Map<string, RecipientOutcome>): Promise<void> {
    await this.transaction(async (client) => {
      for (const [address, outcome] of outcomes) {
        await client.query(
          `
            update outbound_recipients
            set status = $3, response = $4, attempts = attempts + 1,
                next_attempt_at = coalesce($5, next_attempt_at)
            where wrap_id = $1 and address = $2
          `,
          [
            wrapId,
            address,
            outcome.status,
            outcome.response,
            'nextAttemptAt' in outcome ? outcome.nextAttemptAt : null,
          ],
        )
      }
      await client.query(
        `
          update outbound_messages set wrap = null
          where wrap_id = $1
            and not exists (select 1 from outbound_recipients where wrap_id = $1 and status = 'pending')
        `,
        [wrapId],
      )
    })
  }

  async pruneOutboundMessages(before: Date): Promise<number> {
    const result = await this.pool.query(
      `
        delete from outbound_messages m
        where m.received_at < $1
          and not exists (select 1 from outbound_recipients r where r.wrap_id = m.wrap_id and r.status = 'pending')
      `,
      [before],
    )
    return result.rowCount ?? 0
  }

  async addAbuseReport(input: NewAbuseReport): Promise<void> {
    await this.pool.query(
      `
        insert into abuse_reports (domain, email_id, mail_from, header_from, subject, message)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (domain, email_id) do nothing
      `,
      [input.domain, input.emailId, input.mailFrom, input.from, input.subject, input.message],
    )
  }

  async listAbuseReports(reader: AbuseReader): Promise<AbuseReport[]> {
    const { condition, values } = keptBy(reader, 1)
    const result = await this.pool.query<AbuseReportRow>(
      `select ${ABUSE_REPORT_COLUMNS} from abuse_reports where ${condition} order by received_at desc, id desc`,
      values,
    )
    return result.rows.map(toAbuseReport)
  }

  async findAbuseMessage(id: number, reader: AbuseReader): Promise<Buffer | null> {
    const { condition, values } = keptBy(reader, 2)
    const result = await this.pool.query<{ message: Buffer }>(
      `select message from abuse_reports where id = $1 and ${condition}`,
      [id, ...values],
    )
    return result.rows[0]?.message ?? null
  }

  async deleteAbuseReport(id: number, reader: AbuseReader): Promise<boolean> {
    const { condition, values } = keptBy(reader, 2)
    const column = reader === 'admin' ? 'admin_deleted_at' : 'owner_deleted_at'
    return this.transaction(async (client) => {
      const result = await client.query<{ domain: string }>(
        `update abuse_reports set ${column} = now() where id = $1 and ${condition} returning domain`,
        [id, ...values],
      )
      if (!result.rows[0]) return false

      await purgeAbuseReports(client, result.rows[0].domain)
      return true
    })
  }

  async findOrCreateServerKey(generated: KeyPair): Promise<KeyPair> {
    await this.pool.query('insert into server_key (pubkey, private_key) values ($1, $2) on conflict (id) do nothing', [
      generated.pubkey,
      generated.privateKey,
    ])
    const result = await this.pool.query<{ pubkey: string; private_key: string }>(
      'select pubkey, private_key from server_key',
    )
    return { pubkey: result.rows[0].pubkey, privateKey: result.rows[0].private_key }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()

    try {
      await client.query('begin')
      const result = await run(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}

function toDomain(row: DomainRow): Domain {
  return {
    domain: row.domain,
    pubkey: row.pubkey,
    verificationToken: row.verification_token,
    dkimSelector: row.dkim_selector,
    dkimPublicKey: row.dkim_public_key,
    dkimPrivateKey: row.dkim_private_key,
    bridgePubkey: row.bridge_pubkey,
    bridgePrivateKey: row.bridge_private_key,
    bridgeBunker: row.bridge_bunker,
    blossomServers: row.blossom_servers,
    nip05: row.nip05,
    shared: row.shared,
    catchAll: row.catch_all,
    checks: row.checks,
    checkedAt: row.checked_at?.toISOString() ?? null,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

function toSuspension(row: SuspensionRow): Suspension {
  return { domain: row.domain, suspendedAt: row.suspended_at.toISOString() }
}

function toAllowedKey(row: AllowedKeyRow): AllowedKey {
  return { pubkey: row.pubkey, allowedAt: row.allowed_at.toISOString() }
}

function toKeyQuotas(row: KeyQuotasRow): KeyQuotas {
  return { pubkey: row.pubkey, quotas: row.quotas, updatedAt: row.updated_at.toISOString() }
}

function toAbuseReport(row: AbuseReportRow): AbuseReport {
  return {
    id: row.id,
    domain: row.domain,
    mailFrom: row.mail_from,
    from: row.header_from,
    subject: row.subject,
    size: row.size,
    receivedAt: row.received_at.toISOString(),
  }
}

// The reports the reader has not deleted, with the values of the condition numbered from `from`.
function keptBy(reader: AbuseReader, from: number): { condition: string; values: string[] } {
  if (reader === 'admin') return { condition: 'admin_deleted_at is null', values: [] }
  return {
    condition: `owner_deleted_at is null and domain = $${from} and received_at >= $${from + 1}`,
    values: [reader.domain, reader.since],
  }
}

// Drops the reports of the domain the admins deleted and no owner reads any more: deleted by the owner too,
// or received before the claim that owns the domain now, if any.
async function purgeAbuseReports(client: pg.PoolClient, domain: string): Promise<void> {
  await client.query(
    `
      delete from abuse_reports r
      where r.domain = $1 and r.admin_deleted_at is not null
        and (
          r.owner_deleted_at is not null
          or not exists (select 1 from domains d where d.domain = r.domain and d.verified_at <= r.received_at)
        )
    `,
    [domain],
  )
}

function toAddress(row: AddressRow): Address {
  return {
    domain: row.domain,
    localPart: row.local_part,
    pubkey: row.pubkey,
    ownerPubkey: row.owner_pubkey,
    createdBy: row.created_by,
    private: row.private,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
  }
}
