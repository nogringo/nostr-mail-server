import { domainToASCII } from 'node:url'

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

// Validates a domain a user wants to connect and returns its lowercase ASCII
// (punycode) form, or null.
export function normalizeDomain(value: string): string | null {
  const ascii = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ''))
  if (!ascii || ascii.length > 253) return null

  const labels = ascii.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null
  if (/^\d+$/.test(labels[labels.length - 1])) return null

  return ascii
}

// Normalizes a DNS name taken from a record or the configuration, where labels
// such as `_spf` are allowed.
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

// Normalizes a Host header: first value, without the port.
export function normalizeHost(value: string): string {
  const host = value.split(',')[0]?.trim() ?? ''
  return normalizeHostname(stripPort(host))
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }

  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}
