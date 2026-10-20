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
    databaseUrl: 'postgres://localhost/nostrmail',
    mxHost: 'mx.example.org',
    spfInclude: '_spf.example.org',
    dkimSelector: 'nostrmail',
    dnsServers: [],
  })
})

test('loadConfig reads the optional settings', () => {
  const config = loadConfig({
    ...required,
    PORT: '8080',
    DKIM_SELECTOR: 'Mail2026',
    DNS_SERVERS: '1.1.1.1, 2606:4700::1111',
  })

  expect(config.port).toBe(8080)
  expect(config.dkimSelector).toBe('mail2026')
  expect(config.dnsServers).toEqual(['1.1.1.1', '2606:4700::1111'])
})

test.each(Object.keys(required))('loadConfig requires %s', (name) => {
  expect(() => loadConfig({ ...required, [name]: '' })).toThrow(`${name} is required`)
})

test('loadConfig rejects invalid values', () => {
  expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/)
  expect(() => loadConfig({ ...required, MX_HOST: 'localhost' })).toThrow(/MX_HOST/)
  expect(() => loadConfig({ ...required, SPF_INCLUDE: 'include:_spf.example.org' })).toThrow(/SPF_INCLUDE/)
  expect(() => loadConfig({ ...required, DKIM_SELECTOR: 'a.b' })).toThrow(/DKIM_SELECTOR/)
  expect(() => loadConfig({ ...required, DNS_SERVERS: 'dns.google' })).toThrow(/DNS_SERVERS/)
})
