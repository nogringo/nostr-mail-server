import { readdir, readFile } from 'node:fs/promises'
import pg from 'pg'

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url)

// Applies the pending .sql files in order, each in its own transaction.
export async function migrate(databaseUrl: string, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await client.query(`select pg_advisory_lock(hashtext('nostr-mail-server migrations'))`)
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `)

    const result = await client.query<{ name: string }>('select name from schema_migrations')
    const applied = new Set(result.rows.map((row) => row.name))
    const pending = files.filter((file) => !applied.has(file))

    for (const file of pending) {
      const sql = await readFile(new URL(file, dir), 'utf8')
      try {
        await inTransaction(client, async () => {
          await client.query(sql)
          await client.query('insert into schema_migrations (name) values ($1)', [file])
        })
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error })
      }
    }

    return pending
  } finally {
    await client.end()
  }
}

async function inTransaction(client: pg.Client, run: () => Promise<void>): Promise<void> {
  await client.query('begin')
  try {
    await run()
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  }
}
