import { isIP } from 'node:net'
import { normalizeHostname } from './domain.js'
import { parsePubkey } from './nostr.js'
import type { AppConfig, TlsFiles } from './types.js'

const DNS_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/
const SELECTOR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

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
    publicIpv4: parsePublicIpv4(env.PUBLIC_IPV4),
    dkimSelector: parseSelector(env.DKIM_SELECTOR),
    dnsServers: parseDnsServers(env.DNS_SERVERS),
    tls: parseTlsFiles(env.TLS_CERT_FILE, env.TLS_KEY_FILE),
    adminPubkeys: parseAdminPubkeys(env.ADMIN_PUBKEYS),
  }
}

function parseAdminPubkeys(value: string | undefined): string[] {
  const keys = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parsePubkey)

  if (!keys?.length) return []
  if (keys.some((key) => key === null)) {
    throw new Error('ADMIN_PUBKEYS must contain comma-separated npubs or hex public keys')
  }

  return [...new Set(keys as string[])]
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

function parsePublicIpv4(value: string | undefined): string {
  const address = value?.trim()
  if (!address) {
    throw new Error('PUBLIC_IPV4 is required')
  }
  if (isIP(address) !== 4) {
    throw new Error('PUBLIC_IPV4 must be an IPv4 address')
  }

  return address
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
