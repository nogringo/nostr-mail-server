import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDnsLookup } from './dns.js'
import { migrate } from './migrations.js'
import { NostrRelayNetwork } from './relays.js'
import { PgDomainRepository } from './repository.js'
import { createSmtpServer } from './smtp.js'

const config = loadConfig()
const migrations = await migrate(config.databaseUrl)
const repo = new PgDomainRepository(config.databaseUrl)
const app = buildApp(repo, config, createDnsLookup(config.dnsServers), { logger: true })
const relays = new NostrRelayNetwork(config.indexerRelays)
const smtp = createSmtpServer(repo, relays, config, { logger: app.log.child({ component: 'smtp' }) })

if (migrations.length) app.log.info({ migrations }, 'applied database migrations')

const shutdown = async () => {
  await new Promise<void>((resolve) => smtp.close(resolve))
  await app.close()
  await repo.close()
  relays.close()
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0))
})

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0))
})

await app.listen({ host: '0.0.0.0', port: config.port })
await new Promise<void>((resolve) => smtp.listen(config.smtpPort, '0.0.0.0', resolve))
app.log.info({ port: config.smtpPort }, 'SMTP server listening')
