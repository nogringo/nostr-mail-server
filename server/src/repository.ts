import type { NostrEvent } from 'nostr-tools/pure'
import pg from 'pg'
import type {
  AbuseReport,
  Address,
  Domain,
  DomainChecks,
  DomainRepository,
  DomainSummary,
  KeyPair,
  NewAbuseReport,
  NewAddress,
  NewDomain,
  NewOutboundMessage,
  OutboundMessage,
  RecipientOutcome,
  Suspension,
} from './types.js'

const DOMAIN_COLUMNS = `
  domain, pubkey, verification_token, dkim_selector, dkim_public_key, dkim_private_key,
  bridge_pubkey, bridge_private_key, blossom_servers, checks, checked_at, verified_at, created_at
`

const ADDRESS_COLUMNS = 'domain, local_part, pubkey, owner_pubkey, created_at'

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
  bridge_private_key: string
  blossom_servers: string[]
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
  created_at: Date
}

interface SuspensionRow {
  domain: string
  suspended_at: Date
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
      }
      return result.rows[0] ? toDomain(result.rows[0]) : null
    })
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    const result = await this.pool.query('delete from domains where domain = $1 and pubkey = $2', [domain, pubkey])
    return (result.rowCount ?? 0) > 0
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

  async putAddress(input: NewAddress): Promise<Address> {
    const result = await this.pool.query<AddressRow>(
      `
        insert into addresses (domain, local_part, pubkey, owner_pubkey)
        values ($1, $2, $3, $4)
        on conflict (domain, local_part) do update
        set pubkey = excluded.pubkey, owner_pubkey = excluded.owner_pubkey
        returning ${ADDRESS_COLUMNS}
      `,
      [input.domain, input.localPart, input.pubkey, input.ownerPubkey],
    )
    return toAddress(result.rows[0])
  }

  async deleteAddress(domain: string, localPart: string): Promise<boolean> {
    const result = await this.pool.query('delete from addresses where domain = $1 and local_part = $2', [
      domain,
      localPart,
    ])
    return (result.rowCount ?? 0) > 0
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

  async listAbuseReports(filter?: { domain: string; since: string }): Promise<AbuseReport[]> {
    const result = filter
      ? await this.pool.query<AbuseReportRow>(
          `
            select ${ABUSE_REPORT_COLUMNS} from abuse_reports
            where domain = $1 and received_at >= $2
            order by received_at desc, id desc
          `,
          [filter.domain, filter.since],
        )
      : await this.pool.query<AbuseReportRow>(
          `select ${ABUSE_REPORT_COLUMNS} from abuse_reports order by received_at desc, id desc`,
        )
    return result.rows.map(toAbuseReport)
  }

  async findAbuseReport(id: number): Promise<{ report: AbuseReport; message: Buffer } | null> {
    const result = await this.pool.query<AbuseReportRow & { message: Buffer }>(
      `select ${ABUSE_REPORT_COLUMNS}, message from abuse_reports where id = $1`,
      [id],
    )
    const row = result.rows[0]
    return row ? { report: toAbuseReport(row), message: row.message } : null
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
    blossomServers: row.blossom_servers,
    checks: row.checks,
    checkedAt: row.checked_at?.toISOString() ?? null,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

function toSuspension(row: SuspensionRow): Suspension {
  return { domain: row.domain, suspendedAt: row.suspended_at.toISOString() }
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

function toAddress(row: AddressRow): Address {
  return {
    domain: row.domain,
    localPart: row.local_part,
    pubkey: row.pubkey,
    ownerPubkey: row.owner_pubkey,
    createdAt: row.created_at.toISOString(),
  }
}
