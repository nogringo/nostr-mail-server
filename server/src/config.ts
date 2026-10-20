import { isIP } from 'node:net'
import { normalizeHostname } from './domain.js'
import { normalizeRelayUrl } from './nostr.js'
import type { AppConfig } from './types.js'

const DNS_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/
const SELECTOR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const DEFAULT_INDEXER_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es', 'wss://indexer.coracle.social']

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  return {
    port: parsePort(env.PORT, 'PORT', 3000),
    smtpPort: parsePort(env.SMTP_PORT, 'SMTP_PORT', 2525),
    databaseUrl,
    mxHost: parseDnsName(env.MX_HOST, 'MX_HOST'),
    spfInclude: parseDnsName(env.SPF_INCLUDE, 'SPF_INCLUDE'),
    dkimSelector: parseSelector(env.DKIM_SELECTOR),
    dnsServers: parseDnsServers(env.DNS_SERVERS),
    indexerRelays: parseIndexerRelays(env.INDEXER_RELAYS),
  }
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
  if (!value) return fallback

  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }

  return port
}

function parseDnsName(value: string | undefined, name: string): string {
  const hostname = normalizeHostname(value ?? '')
  if (!hostname) {
    throw new Error(`${name} is required`)
  }
  if (!DNS_NAME.test(hostname)) {
    throw new Error(`${name} must be a fully qualified domain name`)
  }

  return hostname
}

function parseSelector(value: string | undefined): string {
  const selector = value?.trim().toLowerCase()
  if (!selector) return 'nostrmail'
  if (!SELECTOR.test(selector)) {
    throw new Error('DKIM_SELECTOR must be a single DNS label')
  }

  return selector
}

function parseDnsServers(value: string | undefined): string[] {
  const servers = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!servers?.length) return []
  if (!servers.every((server) => isIP(server) !== 0)) {
    throw new Error('DNS_SERVERS must contain comma-separated IP addresses')
  }

  return servers
}

function parseIndexerRelays(value: string | undefined): string[] {
  const relays = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!relays?.length) return DEFAULT_INDEXER_RELAYS

  const normalized = relays.map(normalizeRelayUrl)
  if (normalized.some((relay) => relay === null)) {
    throw new Error('INDEXER_RELAYS must contain comma-separated wss:// URLs')
  }

  return normalized as string[]
}
