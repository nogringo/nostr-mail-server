import { buildApp } from './app.js'
import { blossom } from './blossom.js'
import { loadConfig } from './config.js'
import { createSmtpTransport } from './delivery.js'
import { createAuthResolver, createDnsLookup, createExchangerLookup } from './dns.js'
import { migrate } from './migrations.js'
import { Outbox } from './outbox.js'
import { NostrRelayNetwork } from './relays.js'
import { PgDomainRepository } from './repository.js'
import { createSmtpServer } from './smtp.js'
import { readTls, reloadTls } from './tls.js'

const config = loadConfig()
const migrations = await migrate(config.databaseUrl)
const repo = new PgDomainRepository(config.databaseUrl)
const relays = new NostrRelayNetwork(config.indexerRelays)
const app = buildApp(repo, config, createDnsLookup(config.dnsServers), relays, { logger: true })
const smtpLogger = app.log.child({ component: 'smtp' })
// Without the certificate files the server does not start: an orchestrator retries until they exist.
const tls = config.tls ? await readTls(config.tls) : undefined
const smtp = createSmtpServer(repo, relays, blossom, createAuthResolver(config.dnsServers), config, {
  logger: smtpLogger,
  tls,
})
const tlsReload = config.tls && tls ? reloadTls(smtp, config.tls, tls, smtpLogger) : null
// The address of this server should resolve back to MX_HOST, the name it greets with.
const transport = createSmtpTransport({
  heloName: config.mxHost,
  findExchangers: createExchangerLookup(config.dnsServers),
})
const outbox = new Outbox(repo, relays, blossom, transport, config, app.log.child({ component: 'outbox' }))

if (migrations.length) app.log.info({ migrations }, 'applied database migrations')

const shutdown = async () => {
  tlsReload?.stop()
  await outbox.stop()
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
outbox.start()
