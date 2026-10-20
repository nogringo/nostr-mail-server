import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRecords, expectedRecords } from '../src/records.js'
import type { Domain } from '../src/types.js'
import { domainConfig, FakeDns } from './helpers.js'

const domain: Domain = {
  domain: 'example.com',
  pubkey: 'a'.repeat(64),
  verificationToken: 'token123',
  dkimSelector: 'nostrmail',
  dkimPublicKey: 'MIIBIjANBgkqh+kiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA==',
  dkimPrivateKey: 'unused',
  checks: null,
  checkedAt: null,
  verifiedAt: null,
  createdAt: new Date().toISOString(),
}

function configuredDns(): FakeDns {
  const dns = new FakeDns()
  for (const record of expectedRecords(domain, domainConfig)) {
    if (record.type === 'MX') {
      dns.mxRecords.set(record.name, [{ exchange: record.value, priority: record.priority ?? 10 }])
    } else {
      dns.txtRecords.set(record.name, [...(dns.txtRecords.get(record.name) ?? []), record.value])
    }
  }
  return dns
}

test('expectedRecords lists the five records with their names and values', () => {
  const records = expectedRecords(domain, domainConfig)

  assert.deepEqual(
    records.map(({ id, type, name, value, required }) => ({ id, type, name, value, required })),
    [
      {
        id: 'ownership',
        type: 'TXT',
        name: '_nostr-mail.example.com',
        value: 'nostr-mail-verification=token123',
        required: true,
      },
      { id: 'mx', type: 'MX', name: 'example.com', value: 'mx.example.org', required: true },
      { id: 'spf', type: 'TXT', name: 'example.com', value: 'v=spf1 include:_spf.example.org ~all', required: true },
      {
        id: 'dkim',
        type: 'TXT',
        name: 'nostrmail._domainkey.example.com',
        value: `v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`,
        required: true,
      },
      { id: 'dmarc', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none', required: false },
    ],
  )
})

test('checkRecords passes every record published as instructed', async () => {
  const checks = await checkRecords(domain, domainConfig, configuredDns())

  for (const [id, check] of Object.entries(checks)) assert.equal(check.status, 'ok', id)
  assert.deepEqual(checks.mx.found, ['10 mx.example.org'])
  assert.deepEqual(checks.spf.found, ['v=spf1 include:_spf.example.org ~all'])
})

test('checkRecords reports missing records when nothing is published', async () => {
  const checks = await checkRecords(domain, domainConfig, new FakeDns())

  for (const [id, check] of Object.entries(checks)) assert.deepEqual(check, { status: 'missing', found: [] }, id)
})

test('ownership is a mismatch when only another token is published', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_nostr-mail.example.com', ['nostr-mail-verification=someone-else'])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.deepEqual(checks.ownership, { status: 'mismatch', found: ['nostr-mail-verification=someone-else'] })
})

test('ownership passes when other keys also published their token', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_nostr-mail.example.com', [
    'nostr-mail-verification=someone-else',
    'nostr-mail-verification=token123',
  ])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.equal(checks.ownership.status, 'ok')
})

test('MX is a mismatch while another mail server is still listed', async () => {
  const dns = new FakeDns()
  dns.mxRecords.set('example.com', [
    { exchange: 'MX.example.org.', priority: 10 },
    { exchange: 'aspmx.l.google.com', priority: 1 },
  ])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.deepEqual(checks.mx, { status: 'mismatch', found: ['10 mx.example.org', '1 aspmx.l.google.com'] })
})

test('MX matches regardless of case and trailing dot', async () => {
  const dns = new FakeDns()
  dns.mxRecords.set('example.com', [{ exchange: 'MX.Example.org.', priority: 5 }])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.equal(checks.mx.status, 'ok')
})

test('SPF ignores unrelated TXT records and accepts other mechanisms', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('example.com', [
    'google-site-verification=abc',
    'v=spf1 ip4:203.0.113.4 +include:_SPF.example.org -all',
  ])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.deepEqual(checks.spf, { status: 'ok', found: ['v=spf1 ip4:203.0.113.4 +include:_SPF.example.org -all'] })
})

test('SPF is a mismatch without our include or with two SPF records', async () => {
  const withoutInclude = new FakeDns()
  withoutInclude.txtRecords.set('example.com', ['v=spf1 include:_spf.google.com ~all'])
  assert.equal((await checkRecords(domain, domainConfig, withoutInclude)).spf.status, 'mismatch')

  const twoRecords = new FakeDns()
  twoRecords.txtRecords.set('example.com', [
    'v=spf1 include:_spf.example.org ~all',
    'v=spf1 include:_spf.google.com ~all',
  ])
  assert.equal((await checkRecords(domain, domainConfig, twoRecords)).spf.status, 'mismatch')
})

test('DKIM compares the public key, whatever the spacing', async () => {
  const dns = new FakeDns()
  const spaced = domain.dkimPublicKey.replace(/(.{10})/g, '$1 ')
  dns.txtRecords.set('nostrmail._domainkey.example.com', [`k=rsa;v=DKIM1;  p= ${spaced}`])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.equal(checks.dkim.status, 'ok')
})

test('DKIM is a mismatch with another key', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('nostrmail._domainkey.example.com', ['v=DKIM1; k=rsa; p=MIIBOTHERKEY'])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.equal(checks.dkim.status, 'mismatch')
})

test('DMARC is a mismatch when two policies are published', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_dmarc.example.com', ['v=DMARC1; p=none', 'v=DMARC1; p=reject'])

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.equal(checks.dmarc.status, 'mismatch')
})

test('a failing lookup is reported as an error without affecting the others', async () => {
  const dns = configuredDns()
  dns.failing.add('_dmarc.example.com')

  const checks = await checkRecords(domain, domainConfig, dns)
  assert.deepEqual(checks.dmarc, { status: 'error', found: [] })
  assert.equal(checks.ownership.status, 'ok')
})
