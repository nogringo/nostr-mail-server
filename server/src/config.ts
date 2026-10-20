import { isIP } from 'node:net'
import { normalizeBlossomUrl } from './blossom.js'
import { normalizeHostname } from './domain.js'
import { normalizeRelayUrl } from './nostr.js'
import type { AppConfig, TlsFiles } from './types.js'

const DNS_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/
const SELECTOR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const DEFAULT_INDEXER_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es', 'wss://indexer.coracle.social']
// The NIP-65 relays Nostr Mail recommends.
const DEFAULT_DOMAIN_RELAYS = [
  'wss://relay.nmail.li',
  'wss://relay.ditto.pub',
  'wss://nos.lol',
  'wss://relay.primal.net',
]
// The servers Nostr Mail clients always look in, whoever wrote the email.
const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.nmail.li',
  'https://blossom.yakihonne.com',
  'https://blossom.ditto.pub',
]
const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  return {
    port: parsePort(env.PORT, 'PORT', 3000),
    smtpPort: parsePort(env.SMTP_PORT, 'SMTP_PORT', 2525),
    maxMessageBytes: parseMaxMessageBytes(env.MAX_MESSAGE_BYTES),
    databaseUrl,
    mxHost: parseDnsName(env.MX_HOST, 'MX_HOST'),
    spfInclude: parseDnsName(env.SPF_INCLUDE, 'SPF_INCLUDE'),
    dkimSelector: parseSelector(env.DKIM_SELECTOR),
    dnsServers: parseDnsServers(env.DNS_SERVERS),
    indexerRelays: parseUrls(env.INDEXER_RELAYS, 'INDEXER_RELAYS', normalizeRelayUrl, DEFAULT_INDEXER_RELAYS),
    domainRelays: parseUrls(env.DOMAIN_RELAYS, 'DOMAIN_RELAYS', normalizeRelayUrl, DEFAULT_DOMAIN_RELAYS),
    blossomServers: parseUrls(env.BLOSSOM_SERVERS, 'BLOSSOM_SERVERS', normalizeBlossomUrl, DEFAULT_BLOSSOM_SERVERS),
    tls: parseTlsFiles(env.TLS_CERT_FILE, env.TLS_KEY_FILE),
  }
}

function parseTlsFiles(cert: string | undefined, key: string | undefined): TlsFiles | null {
  const certFile = cert?.trim()
  const keyFile = key?.trim()
  if (!certFile && !keyFile) return null
  if (!certFile || !keyFile) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together')
  }

  return { certFile, keyFile }
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

function parseMaxMessageBytes(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_MESSAGE_BYTES

  const bytes = Number(value)
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('MAX_MESSAGE_BYTES must be a positive integer')
  }

  return bytes
}

function parseUrls(
  value: string | undefined,
  name: string,
  normalize: (url: string) => string | null,
  fallback: string[],
): string[] {
  const urls = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!urls?.length) return fallback

  const normalized = urls.map(normalize)
  if (normalized.some((url) => url === null)) {
    throw new Error(`${name} must contain comma-separated URLs of public hosts`)
  }

  return normalized as string[]
}
