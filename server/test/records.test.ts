import { expect, test } from 'vitest'
import { checkRecords, checkServerRecords, expectedRecords } from '../src/records.js'
import type { Domain } from '../src/types.js'
import { domainConfig, FakeDns, fakeNip05 } from './helpers.js'

const domain: Domain = {
  domain: 'example.com',
  pubkey: 'a'.repeat(64),
  verificationToken: 'token123',
  dkimSelector: 'nostrmail',
  dkimPublicKey: 'MIIBIjANBgkqh+kiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA==',
  dkimPrivateKey: 'unused',
  bridgePubkey: 'b'.repeat(64),
  bridgePrivateKey: 'unused',
  bridgeBunker: null,
  blossomServers: [],
  nip05: 'server',
  checks: null,
  checkedAt: null,
  verifiedAt: null,
  createdAt: new Date().toISOString(),
}

const ownNip05: Domain = { ...domain, nip05: 'owner' }

function configuredDns(): FakeDns {
  const dns = new FakeDns()
  for (const record of expectedRecords(domain, domainConfig)) {
    if (record.type === 'MX') {
      dns.mxRecords.set(record.name, [{ exchange: record.value, priority: record.priority ?? 10 }])
    } else if (record.type === 'A') {
      dns.addressRecords.set(record.name, [record.value])
    } else {
      dns.txtRecords.set(record.name, [...(dns.txtRecords.get(record.name) ?? []), record.value])
    }
  }
  return dns
}

test('expectedRecords lists the six records with their names and values', () => {
  const records = expectedRecords(domain, domainConfig)

  expect(records.map(({ id, type, name, value, required }) => ({ id, type, name, value, required }))).toEqual([
    {
      id: 'ownership',
      type: 'TXT',
      name: '_nostr-mail.example.com',
      value: 'nostr-mail-verification=token123',
      required: true,
    },
    { id: 'mx', type: 'MX', name: 'example.com', value: 'mx.example.org', required: true },
    { id: 'nip05', type: 'A', name: 'example.com', value: '192.0.2.10', required: true },
    { id: 'spf', type: 'TXT', name: 'example.com', value: 'v=spf1 include:_spf.example.org ~all', required: true },
    {
      id: 'dkim',
      type: 'TXT',
      name: 'nostrmail._domainkey.example.com',
      value: `v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`,
      required: true,
    },
    { id: 'dmarc', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none', required: false },
  ])
})

test('checkRecords passes every record published as instructed', async () => {
  const checks = await checkRecords(domain, domainConfig, configuredDns(), fakeNip05())

  for (const [id, check] of Object.entries(checks)) expect(check.status, id).toBe('ok')
  expect(checks.mx.found).toEqual(['10 mx.example.org'])
  expect(checks.nip05.found).toEqual(['192.0.2.10'])
  expect(checks.spf.found).toEqual(['v=spf1 include:_spf.example.org ~all'])
})

test('checkRecords reports missing records when nothing is published', async () => {
  const checks = await checkRecords(domain, domainConfig, new FakeDns(), fakeNip05())

  for (const [id, check] of Object.entries(checks)) expect(check, id).toEqual({ status: 'missing', found: [] })
})

test('ownership is a mismatch when only another token is published', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_nostr-mail.example.com', ['nostr-mail-verification=someone-else'])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.ownership).toEqual({ status: 'mismatch', found: ['nostr-mail-verification=someone-else'] })
})

test('ownership passes when other keys also published their token', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_nostr-mail.example.com', [
    'nostr-mail-verification=someone-else',
    'nostr-mail-verification=token123',
  ])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.ownership.status).toBe('ok')
})

test('MX is a mismatch while another mail server is still listed', async () => {
  const dns = new FakeDns()
  dns.mxRecords.set('example.com', [
    { exchange: 'MX.example.org.', priority: 10 },
    { exchange: 'aspmx.l.google.com', priority: 1 },
  ])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.mx).toEqual({ status: 'mismatch', found: ['10 mx.example.org', '1 aspmx.l.google.com'] })
})

test('MX matches regardless of case and trailing dot', async () => {
  const dns = new FakeDns()
  dns.mxRecords.set('example.com', [{ exchange: 'MX.Example.org.', priority: 5 }])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.mx.status).toBe('ok')
})

test('A is a mismatch while another address or an AAAA record remains', async () => {
  const otherHost = new FakeDns()
  otherHost.addressRecords.set('example.com', ['192.0.2.10', '198.51.100.7'])
  expect((await checkRecords(domain, domainConfig, otherHost, fakeNip05())).nip05).toEqual({
    status: 'mismatch',
    found: ['192.0.2.10', '198.51.100.7'],
  })

  const ipv6 = new FakeDns()
  ipv6.addressRecords.set('example.com', ['192.0.2.10', '2001:db8::1'])
  expect((await checkRecords(domain, domainConfig, ipv6, fakeNip05())).nip05.status).toBe('mismatch')
})

test('expectedRecords asks for _smtp in nostr.json when the owner serves NIP-05', () => {
  const record = expectedRecords(ownNip05, domainConfig).find(({ id }) => id === 'nip05')

  expect(record).toEqual({
    id: 'nip05',
    type: 'NIP-05',
    name: '_smtp@example.com',
    value: domain.bridgePubkey,
    required: true,
  })
})

test('NIP-05 served by the owner passes once _smtp lists the domain key, whatever the A record', async () => {
  const listed = fakeNip05({ '_smtp@example.com': { pubkey: domain.bridgePubkey } })

  const checks = await checkRecords(ownNip05, domainConfig, new FakeDns(), listed)
  expect(checks.nip05).toEqual({ status: 'ok', found: [domain.bridgePubkey] })
})

test('NIP-05 served by the owner is a mismatch with another key or a redirect', async () => {
  const otherKey = fakeNip05({ '_smtp@example.com': { pubkey: 'c'.repeat(64) } })
  expect((await checkRecords(ownNip05, domainConfig, new FakeDns(), otherKey)).nip05).toEqual({
    status: 'mismatch',
    found: ['c'.repeat(64)],
  })

  const redirect = fakeNip05({ '_smtp@example.com': { redirect: 'https://www.example.com/.well-known/nostr.json' } })
  expect((await checkRecords(ownNip05, domainConfig, new FakeDns(), redirect)).nip05).toEqual({
    status: 'mismatch',
    found: ['Redirect to https://www.example.com/.well-known/nostr.json'],
  })
})

test('NIP-05 served by the owner is missing without _smtp, and an error when the site does not answer', async () => {
  expect((await checkRecords(ownNip05, domainConfig, new FakeDns(), fakeNip05())).nip05).toEqual({
    status: 'missing',
    found: [],
  })

  const unreachable = async () => {
    throw new TypeError('fetch failed')
  }
  expect((await checkRecords(ownNip05, domainConfig, new FakeDns(), unreachable)).nip05).toEqual({
    status: 'error',
    found: [],
  })
})

test('SPF ignores unrelated TXT records and accepts other mechanisms', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('example.com', [
    'google-site-verification=abc',
    'v=spf1 ip4:203.0.113.4 +include:_SPF.example.org -all',
  ])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.spf).toEqual({ status: 'ok', found: ['v=spf1 ip4:203.0.113.4 +include:_SPF.example.org -all'] })
})

test('SPF is a mismatch without our include or with two SPF records', async () => {
  const withoutInclude = new FakeDns()
  withoutInclude.txtRecords.set('example.com', ['v=spf1 include:_spf.google.com ~all'])
  expect((await checkRecords(domain, domainConfig, withoutInclude, fakeNip05())).spf.status).toBe('mismatch')

  const twoRecords = new FakeDns()
  twoRecords.txtRecords.set('example.com', [
    'v=spf1 include:_spf.example.org ~all',
    'v=spf1 include:_spf.google.com ~all',
  ])
  expect((await checkRecords(domain, domainConfig, twoRecords, fakeNip05())).spf.status).toBe('mismatch')
})

test('DKIM compares the public key, whatever the spacing', async () => {
  const dns = new FakeDns()
  const spaced = domain.dkimPublicKey.replace(/(.{10})/g, '$1 ')
  dns.txtRecords.set('nostrmail._domainkey.example.com', [`k=rsa;v=DKIM1;  p= ${spaced}`])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.dkim.status).toBe('ok')
})

test('DKIM is a mismatch with another key', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('nostrmail._domainkey.example.com', ['v=DKIM1; k=rsa; p=MIIBOTHERKEY'])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.dkim.status).toBe('mismatch')
})

test('DMARC is a mismatch when two policies are published', async () => {
  const dns = new FakeDns()
  dns.txtRecords.set('_dmarc.example.com', ['v=DMARC1; p=none', 'v=DMARC1; p=reject'])

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.dmarc.status).toBe('mismatch')
})

test('a failing lookup is reported as an error without affecting the others', async () => {
  const dns = configuredDns()
  dns.failing.add('_dmarc.example.com')

  const checks = await checkRecords(domain, domainConfig, dns, fakeNip05())
  expect(checks.dmarc).toEqual({ status: 'error', found: [] })
  expect(checks.ownership.status).toBe('ok')
})

function configuredServerDns(): FakeDns {
  const dns = new FakeDns()
  dns.addressRecords.set('mx.example.org', ['192.0.2.10'])
  dns.ptrRecords.set('192.0.2.10', ['mx.example.org'])
  dns.txtRecords.set('_spf.example.org', ['v=spf1 ip4:192.0.2.10 -all'])
  return dns
}

test('checkServerRecords passes a server whose name, address and SPF record agree', async () => {
  const records = await checkServerRecords(domainConfig, configuredServerDns())

  expect(records).toEqual([
    {
      id: 'host',
      type: 'A',
      name: 'mx.example.org',
      value: '192.0.2.10',
      check: { status: 'ok', found: ['192.0.2.10'] },
    },
    {
      id: 'ptr',
      type: 'PTR',
      name: '192.0.2.10',
      value: 'mx.example.org',
      check: { status: 'ok', found: ['mx.example.org'] },
    },
    {
      id: 'spf',
      type: 'TXT',
      name: '_spf.example.org',
      value: 'v=spf1 ip4:192.0.2.10 -all',
      check: { status: 'ok', found: ['v=spf1 ip4:192.0.2.10 -all'] },
    },
  ])
})

test('checkServerRecords reports missing records when nothing is published', async () => {
  const records = await checkServerRecords(domainConfig, new FakeDns())

  for (const record of records) expect(record.check, record.id).toEqual({ status: 'missing', found: [] })
})

test('the server SPF record may list the address with other mechanisms', async () => {
  for (const record of ['v=spf1 a:mx.example.org -all', 'v=spf1 ip4:192.0.2.0/24 ~all']) {
    const dns = configuredServerDns()
    dns.txtRecords.set('_spf.example.org', ['google-site-verification=abc', record])

    const [, , spf] = await checkServerRecords(domainConfig, dns)
    expect(spf.check, record).toEqual({ status: 'ok', found: [record] })
  }
})

test('the server SPF record is a mismatch when it does not list the address', async () => {
  const dns = configuredServerDns()
  dns.txtRecords.set('_spf.example.org', ['v=spf1 ip4:198.51.100.7 -all'])

  const [, , spf] = await checkServerRecords(domainConfig, dns)
  expect(spf.check).toEqual({ status: 'mismatch', found: ['v=spf1 ip4:198.51.100.7 -all'] })
})

test('the server SPF record is an error when a name it includes cannot be looked up', async () => {
  const dns = configuredServerDns()
  dns.txtRecords.set('_spf.example.org', ['v=spf1 include:_spf.broken.example -all'])
  dns.failing.add('_spf.broken.example')

  const [, , spf] = await checkServerRecords(domainConfig, dns)
  expect(spf.check).toEqual({ status: 'error', found: ['v=spf1 include:_spf.broken.example -all'] })
})

test('PTR matches regardless of case and trailing dot, and is a mismatch for another name', async () => {
  const dns = configuredServerDns()
  dns.ptrRecords.set('192.0.2.10', ['MX.Example.org.'])
  expect((await checkServerRecords(domainConfig, dns))[1].check.status).toBe('ok')

  dns.ptrRecords.set('192.0.2.10', ['vps-123.provider.example.'])
  expect((await checkServerRecords(domainConfig, dns))[1].check).toEqual({
    status: 'mismatch',
    found: ['vps-123.provider.example'],
  })
})

test('the server A record is a mismatch with an AAAA record', async () => {
  const dns = configuredServerDns()
  dns.addressRecords.set('mx.example.org', ['192.0.2.10', '2001:db8::1'])

  const [host] = await checkServerRecords(domainConfig, dns)
  expect(host.check).toEqual({ status: 'mismatch', found: ['192.0.2.10', '2001:db8::1'] })
})
