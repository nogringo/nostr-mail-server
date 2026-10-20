import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

const required = {
  DATABASE_URL: 'postgres://localhost/nostrmail',
  MX_HOST: 'MX.Example.org.',
  SPF_INCLUDE: '_spf.example.org',
}

test('loadConfig applies the defaults', () => {
  assert.deepEqual(loadConfig(required), {
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

  assert.equal(config.port, 8080)
  assert.equal(config.dkimSelector, 'mail2026')
  assert.deepEqual(config.dnsServers, ['1.1.1.1', '2606:4700::1111'])
})

test('loadConfig requires the database, MX host and SPF include', () => {
  for (const name of Object.keys(required)) {
    assert.throws(() => loadConfig({ ...required, [name]: '' }), new RegExp(`${name} is required`))
  }
})

test('loadConfig rejects invalid values', () => {
  assert.throws(() => loadConfig({ ...required, PORT: '70000' }), /PORT/)
  assert.throws(() => loadConfig({ ...required, MX_HOST: 'localhost' }), /MX_HOST/)
  assert.throws(() => loadConfig({ ...required, SPF_INCLUDE: 'include:_spf.example.org' }), /SPF_INCLUDE/)
  assert.throws(() => loadConfig({ ...required, DKIM_SELECTOR: 'a.b' }), /DKIM_SELECTOR/)
  assert.throws(() => loadConfig({ ...required, DNS_SERVERS: 'dns.google' }), /DNS_SERVERS/)
})
