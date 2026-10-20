import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDomain, normalizeHost } from '../src/domain.js'

test('normalizeDomain lowercases and drops the trailing dot', () => {
  assert.equal(normalizeDomain(' Example.COM. '), 'example.com')
  assert.equal(normalizeDomain('mail.team.example.co.uk'), 'mail.team.example.co.uk')
})

test('normalizeDomain converts internationalized names to punycode', () => {
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de')
})

test('normalizeDomain rejects what cannot be a mail domain', () => {
  for (const value of [
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
  ]) {
    assert.equal(normalizeDomain(value), null, value)
  }
})

test('normalizeHost strips the port and keeps the first forwarded host', () => {
  assert.equal(normalizeHost('App.Example.org:3000'), 'app.example.org')
  assert.equal(normalizeHost('app.example.org, proxy.internal'), 'app.example.org')
  assert.equal(normalizeHost('[::1]:3000'), '[::1]')
})
