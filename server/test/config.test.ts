import { npubEncode } from 'nostr-tools/nip19'
import { expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'

const ADMIN = 'a'.repeat(64)

const required = {
  DATABASE_URL: 'postgres://localhost/nostrmail',
  MX_HOST: 'MX.Example.org.',
  SPF_INCLUDE: '_spf.example.org',
  PUBLIC_IPV4: ' 192.0.2.10 ',
}

test('loadConfig applies the defaults', () => {
  expect(loadConfig(required)).toEqual({
    port: 3000,
    smtpPort: 2525,
    databaseUrl: 'postgres://localhost/nostrmail',
    mxHost: 'mx.example.org',
    spfInclude: '_spf.example.org',
    publicIpv4: '192.0.2.10',
    dkimSelector: 'nostrmail',
    dnsServers: [],
    tls: null,
    adminPubkeys: [],
  })
})

test('loadConfig reads the optional settings', () => {
  const config = loadConfig({
    ...required,
    PORT: '8080',
    SMTP_PORT: '25',
    DKIM_SELECTOR: 'Mail2026',
    DNS_SERVERS: '1.1.1.1, 2606:4700::1111',
    TLS_CERT_FILE: '/certs/mx.crt',
    TLS_KEY_FILE: ' /certs/mx.key ',
    ADMIN_PUBKEYS: `${npubEncode(ADMIN)}, ${'B'.repeat(64)}, ${ADMIN}`,
  })

  expect(config.port).toBe(8080)
  expect(config.smtpPort).toBe(25)
  expect(config.dkimSelector).toBe('mail2026')
  expect(config.dnsServers).toEqual(['1.1.1.1', '2606:4700::1111'])
  expect(config.tls).toEqual({ certFile: '/certs/mx.crt', keyFile: '/certs/mx.key' })
  expect(config.adminPubkeys).toEqual([ADMIN, 'b'.repeat(64)])
})

test.each(Object.keys(required))('loadConfig requires %s', (name) => {
  expect(() => loadConfig({ ...required, [name]: '' })).toThrow(`${name} is required`)
})

test('loadConfig rejects invalid values', () => {
  expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/)
  expect(() => loadConfig({ ...required, SMTP_PORT: '0' })).toThrow(/SMTP_PORT/)
  expect(() => loadConfig({ ...required, MX_HOST: 'localhost' })).toThrow(/MX_HOST/)
  expect(() => loadConfig({ ...required, TLS_CERT_FILE: '/certs/mx.crt' })).toThrow(/TLS_KEY_FILE/)
  expect(() => loadConfig({ ...required, SPF_INCLUDE: 'include:_spf.example.org' })).toThrow(/SPF_INCLUDE/)
  expect(() => loadConfig({ ...required, DKIM_SELECTOR: 'a.b' })).toThrow(/DKIM_SELECTOR/)
  expect(() => loadConfig({ ...required, DNS_SERVERS: 'dns.google' })).toThrow(/DNS_SERVERS/)
  expect(() => loadConfig({ ...required, PUBLIC_IPV4: '2001:db8::1' })).toThrow(/PUBLIC_IPV4/)
  expect(() => loadConfig({ ...required, ADMIN_PUBKEYS: 'alice@example.com' })).toThrow(/ADMIN_PUBKEYS/)
})
