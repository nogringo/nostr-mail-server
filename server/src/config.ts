import { isIP } from 'node:net'
import { normalizeHostname } from './domain.js'
import type { AppConfig } from './types.js'

const DNS_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/
const SELECTOR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  return {
    port: parsePort(env.PORT),
    databaseUrl,
    mxHost: parseDnsName(env.MX_HOST, 'MX_HOST'),
    spfInclude: parseDnsName(env.SPF_INCLUDE, 'SPF_INCLUDE'),
    dkimSelector: parseSelector(env.DKIM_SELECTOR),
    dnsServers: parseDnsServers(env.DNS_SERVERS),
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000

  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
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
