import { expect, test } from 'vitest'
import { normalizeDomain, normalizeHost } from '../src/domain.js'

test('normalizeDomain lowercases and drops the trailing dot', () => {
  expect(normalizeDomain(' Example.COM. ')).toBe('example.com')
  expect(normalizeDomain('mail.team.example.co.uk')).toBe('mail.team.example.co.uk')
})

test('normalizeDomain converts internationalized names to punycode', () => {
  expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de')
})

test.each([
  '',
  'localhost',
  'example..com',
  '-example.com',
  'example-.com',
  '_dmarc.example.com',
  'exa mple.com',
  'alice@example.com',
  '192.168.1.1',
  `${'a'.repeat(64)}.com`,
  `${'a.'.repeat(127)}com`,
])('normalizeDomain rejects %j', (value) => {
  expect(normalizeDomain(value)).toBeNull()
})

test('normalizeHost strips the port and keeps the first forwarded host', () => {
  expect(normalizeHost('App.Example.org:3000')).toBe('app.example.org')
  expect(normalizeHost('app.example.org, proxy.internal')).toBe('app.example.org')
  expect(normalizeHost('[::1]:3000')).toBe('[::1]')
})
