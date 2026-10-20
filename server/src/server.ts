import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDnsLookup } from './dns.js'
import { migrate } from './migrations.js'
import { PgDomainRepository } from './repository.js'

const config = loadConfig()
const migrations = await migrate(config.databaseUrl)
const repo = new PgDomainRepository(config.databaseUrl)
const app = buildApp(repo, config, createDnsLookup(config.dnsServers), { logger: true })

if (migrations.length) app.log.info({ migrations }, 'applied database migrations')

const shutdown = async () => {
  await app.close()
  await repo.close()
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0))
})

await app.listen({ host: '0.0.0.0', port: config.port })
