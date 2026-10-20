import { expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'

const required = {
  DATABASE_URL: 'postgres://localhost/nostrmail',
  MX_HOST: 'MX.Example.org.',
  SPF_INCLUDE: '_spf.example.org',
}

test('loadConfig applies the defaults', () => {
  expect(loadConfig(required)).toEqual({
    port: 3000,
    smtpPort: 2525,
    maxMessageBytes: 25 * 1024 * 1024,
    databaseUrl: 'postgres://localhost/nostrmail',
    mxHost: 'mx.example.org',
    spfInclude: '_spf.example.org',
    dkimSelector: 'nostrmail',
    dnsServers: [],
    indexerRelays: ['wss://purplepag.es', 'wss://user.kindpag.es', 'wss://indexer.coracle.social'],
    domainRelays: ['wss://relay.nmail.li', 'wss://relay.ditto.pub', 'wss://nos.lol', 'wss://relay.primal.net'],
    blossomServers: ['https://blossom.nmail.li', 'https://blossom.yakihonne.com', 'https://blossom.ditto.pub'],
    tls: null,
  })
})

test('loadConfig reads the optional settings', () => {
  const config = loadConfig({
    ...required,
    PORT: '8080',
    SMTP_PORT: '25',
    INDEXER_RELAYS: 'wss://Relay.Example.com, wss://indexer.example.org/',
    BLOSSOM_SERVERS: 'https://Blossom.Example.com/, https://cdn.example.org/blossom/',
    DOMAIN_RELAYS: 'wss://relay.example.com',
    MAX_MESSAGE_BYTES: '1048576',
    DKIM_SELECTOR: 'Mail2026',
    DNS_SERVERS: '1.1.1.1, 2606:4700::1111',
    TLS_CERT_FILE: '/certs/mx.crt',
    TLS_KEY_FILE: ' /certs/mx.key ',
  })

  expect(config.port).toBe(8080)
  expect(config.smtpPort).toBe(25)
  expect(config.indexerRelays).toEqual(['wss://relay.example.com/', 'wss://indexer.example.org/'])
  expect(config.blossomServers).toEqual(['https://blossom.example.com', 'https://cdn.example.org/blossom'])
  expect(config.maxMessageBytes).toBe(1048576)
  expect(config.domainRelays).toEqual(['wss://relay.example.com/'])
  expect(config.dkimSelector).toBe('mail2026')
  expect(config.dnsServers).toEqual(['1.1.1.1', '2606:4700::1111'])
  expect(config.tls).toEqual({ certFile: '/certs/mx.crt', keyFile: '/certs/mx.key' })
})

test.each(Object.keys(required))('loadConfig requires %s', (name) => {
  expect(() => loadConfig({ ...required, [name]: '' })).toThrow(`${name} is required`)
})

test('loadConfig rejects invalid values', () => {
  expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/)
  expect(() => loadConfig({ ...required, SMTP_PORT: '0' })).toThrow(/SMTP_PORT/)
  expect(() => loadConfig({ ...required, INDEXER_RELAYS: 'ws://relay.example.com' })).toThrow(/INDEXER_RELAYS/)
  expect(() => loadConfig({ ...required, BLOSSOM_SERVERS: 'http://blossom.example.com' })).toThrow(/BLOSSOM_SERVERS/)
  expect(() => loadConfig({ ...required, MAX_MESSAGE_BYTES: '1.5' })).toThrow(/MAX_MESSAGE_BYTES/)
  expect(() => loadConfig({ ...required, DOMAIN_RELAYS: 'wss://localhost' })).toThrow(/DOMAIN_RELAYS/)
  expect(() => loadConfig({ ...required, MX_HOST: 'localhost' })).toThrow(/MX_HOST/)
  expect(() => loadConfig({ ...required, TLS_CERT_FILE: '/certs/mx.crt' })).toThrow(/TLS_KEY_FILE/)
  expect(() => loadConfig({ ...required, SPF_INCLUDE: 'include:_spf.example.org' })).toThrow(/SPF_INCLUDE/)
  expect(() => loadConfig({ ...required, DKIM_SELECTOR: 'a.b' })).toThrow(/DKIM_SELECTOR/)
  expect(() => loadConfig({ ...required, DNS_SERVERS: 'dns.google' })).toThrow(/DNS_SERVERS/)
})
