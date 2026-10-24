import { buildApp } from './app.js'
import { blossom } from './blossom.js'
import { DomainSigners } from './bunker.js'
import { loadConfig } from './config.js'
import { createSmtpTransport } from './delivery.js'
import { createAuthResolver, createDnsLookup, createExchangerLookup } from './dns.js'
import { registerBlossomRoutes } from './handlers/blossom.js'
import { registerRelayRoutes } from './handlers/relay.js'
import { listsTargets, publishEveryDomainLists } from './lists.js'
import { migrate } from './migrations.js'
import { generateKeyPair } from './nostr.js'
import { Outbox } from './outbox.js'
import { QuotaKeeper } from './quotas.js'
import { NostrRelayNetwork } from './relays.js'
import { PgDomainRepository } from './repository.js'
import { SettingsStore } from './settings.js'
import { createSmtpServer } from './smtp.js'
import { readTls, reloadTls } from './tls.js'

const config = loadConfig()
const migrations = await migrate(config.databaseUrl)
const repo = new PgDomainRepository(config.databaseUrl)
const serverKey = await repo.findOrCreateServerKey(generateKeyPair())
const settings = await SettingsStore.load(repo)
const relays = new NostrRelayNetwork(() => settings.current.indexerRelays)
// One registry for the API, SMTP and the outbox, so that each bunker gets one connection.
const signers = new DomainSigners({ logger: { info: (details, message) => app.log.info(details, message) } })
const quotas = new QuotaKeeper(repo, settings, config.adminPubkeys)
const app = buildApp(repo, config, createDnsLookup(config.dnsServers), relays, settings, {
  logger: true,
  signers,
  quotas,
})
const smtpLogger = app.log.child({ component: 'smtp' })
// Without the certificate files the server does not start: an orchestrator retries until they exist.
const tls = config.tls ? await readTls(config.tls) : undefined
const smtp = createSmtpServer(
  repo,
  relays,
  blossom,
  createAuthResolver(config.dnsServers),
  settings,
  { ...config, serverPrivateKey: serverKey.privateKey },
  { logger: smtpLogger, tls, signers, quotas },
)
const tlsReload = config.tls && tls ? reloadTls(smtp, config.tls, tls, smtpLogger) : null
// The address of this server should resolve back to MX_HOST, the name it greets with.
const transport = createSmtpTransport({
  heloName: config.mxHost,
  findExchangers: createExchangerLookup(config.dnsServers),
})
const outbox = new Outbox(
  repo,
  relays,
  blossom,
  transport,
  settings,
  app.log.child({ component: 'outbox' }),
  signers,
  quotas,
)
registerRelayRoutes(app, repo, outbox)
registerBlossomRoutes(app, repo, { config, settings, outbox })

if (migrations.length) app.log.info({ migrations }, 'applied database migrations')
if (await settings.announce(config.relayUrl, config.blossomUrl)) {
  void publishEveryDomainLists(repo, relays, signers, listsTargets(config, settings.current)).then(
    (failed) =>
      app.log.info({ failed }, 'Published the lists of the domain keys naming the server relay and Blossom server'),
    (error) => app.log.error({ error }, 'The lists of the domain keys could not be published'),
  )
}

const shutdown = async () => {
  tlsReload?.stop()
  await outbox.stop()
  await new Promise<void>((resolve) => smtp.close(resolve))
  await app.close()
  await repo.close()
  await signers.close()
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
app.log.info({ port: config.smtpPort, serverPubkey: serverKey.pubkey }, 'SMTP server listening')
outbox.start()
