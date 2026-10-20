import pg from 'pg'
import type { Address, Domain, DomainChecks, DomainRepository, NewAddress, NewDomain } from './types.js'

const DOMAIN_COLUMNS = `
  domain, pubkey, verification_token, dkim_selector, dkim_public_key, dkim_private_key,
  bridge_pubkey, bridge_private_key, blossom_servers, checks, checked_at, verified_at, created_at
`

const ADDRESS_COLUMNS = 'domain, local_part, pubkey, owner_pubkey, created_at'

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
      `select ${DOMAIN_COLUMNS} from domains where domain = $1 and verified_at is not null`,
      [domain],
    )
    return result.rows[0] ? toDomain(result.rows[0]) : null
  }

  async listDomains(pubkey: string): Promise<Domain[]> {
    const result = await this.pool.query<DomainRow>(
      `select ${DOMAIN_COLUMNS} from domains where pubkey = $1 order by domain asc`,
      [pubkey],
    )
    return result.rows.map(toDomain)
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
    const client = await this.pool.connect()

    try {
      await client.query('begin')
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
      await client.query('commit')
      return result.rows[0] ? toDomain(result.rows[0]) : null
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteDomain(domain: string, pubkey: string): Promise<boolean> {
    const result = await this.pool.query('delete from domains where domain = $1 and pubkey = $2', [domain, pubkey])
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

  async close(): Promise<void> {
    await this.pool.end()
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

function toAddress(row: AddressRow): Address {
  return {
    domain: row.domain,
    localPart: row.local_part,
    pubkey: row.pubkey,
    ownerPubkey: row.owner_pubkey,
    createdAt: row.created_at.toISOString(),
  }
}
