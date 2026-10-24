import { expect, test } from 'vitest'
import { parseSettingsChanges } from '../src/settings.js'
import { apiConfig, MemoryDomainRepository, settingsStore } from './helpers.js'

const DAY_MS = 24 * 3600_000
const RELAY = apiConfig.relayUrl
const BLOSSOM = apiConfig.blossomUrl

test('announcing the server relay retires the relays announced before for seven days', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, { domainRelays: ['wss://old.example.org/', 'wss://other.example.org/'] })
  const now = Date.parse('2026-10-21T12:00:00Z')

  expect(await settings.announce(RELAY, BLOSSOM, now)).toBe(true)

  expect(repo.storedSettings.domainRelays).toEqual([RELAY])
  expect(repo.storedSettings.domainBlossomServer).toBe(BLOSSOM)
  expect(settings.outboxRelays(now + 6 * DAY_MS)).toEqual(['wss://old.example.org/', 'wss://other.example.org/'])
  expect(settings.outboxRelays(now + 8 * DAY_MS)).toEqual([])
  expect(repo.storedSettings.retiredDomainRelays).toEqual({
    'wss://old.example.org/': '2026-10-28T12:00:00.000Z',
    'wss://other.example.org/': '2026-10-28T12:00:00.000Z',
  })
})

test('announcing what is already announced changes nothing, and a new Blossom server alone retires no relay', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, { domainRelays: [RELAY], domainBlossomServer: BLOSSOM })

  expect(await settings.announce(RELAY, BLOSSOM)).toBe(false)
  expect(await settings.announce(RELAY, 'https://other.example.org')).toBe(true)

  expect(repo.storedSettings.domainBlossomServer).toBe('https://other.example.org')
  expect(settings.outboxRelays()).toEqual([])
})

test('a relay announced again is no longer retired, and expired ones are dropped', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, { domainRelays: ['wss://a.example.org/'] })
  const now = Date.parse('2026-10-21T12:00:00Z')
  await settings.announce('wss://b.example.org/', BLOSSOM, now)
  await settings.announce('wss://c.example.org/', BLOSSOM, now + 8 * DAY_MS)

  await settings.announce('wss://b.example.org/', BLOSSOM, now + 8 * DAY_MS)

  expect(repo.storedSettings.retiredDomainRelays).toEqual({ 'wss://c.example.org/': '2026-11-05T12:00:00.000Z' })
})

test('changing a setting keeps the relays and returns the settings without them', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, {
    retiredDomainRelays: { 'wss://old.example.org/': '2026-10-28T12:00:00.000Z' },
  })

  const updated = await settings.update({ openRegistration: true })

  expect(updated).toEqual({ ...settings.current, openRegistration: true })
  expect(updated).not.toHaveProperty('domainRelays')
  expect(updated).not.toHaveProperty('domainBlossomServer')
  expect(updated).not.toHaveProperty('retiredDomainRelays')
  expect(repo.storedSettings.domainRelays).toEqual([RELAY])
  expect(repo.storedSettings.retiredDomainRelays).toEqual({ 'wss://old.example.org/': '2026-10-28T12:00:00.000Z' })
})

test('parses the settings an admin changes, URLs normalized and once each', () => {
  expect(
    parseSettingsChanges({
      openRegistration: true,
      maxMessageBytes: 10 * 1024 * 1024,
      maxBlobStorageBytes: 50 * 1024 * 1024 * 1024,
      blossomServers: ['https://Blossom.Example.com/', 'https://blossom.example.com'],
      indexerRelays: [' wss://indexer.example.com/ '],
      quotas: { addresses: 0, recipientsPerDay: null },
    }),
  ).toEqual({
    changes: {
      openRegistration: true,
      maxMessageBytes: 10 * 1024 * 1024,
      maxBlobStorageBytes: 50 * 1024 * 1024 * 1024,
      blossomServers: ['https://blossom.example.com'],
      indexerRelays: ['wss://indexer.example.com/'],
      quotas: { addresses: 0, recipientsPerDay: null },
    },
  })
  expect(parseSettingsChanges({})).toEqual({ changes: {} })
  expect(parseSettingsChanges({ domainRelays: ['wss://relay.example.com/'] })).toEqual({ changes: {} })
})

test.each([
  [null, 'invalid_settings'],
  [[], 'invalid_settings'],
  [{ openRegistration: 'true' }, 'invalid_open_registration'],
  [{ maxMessageBytes: 1024 }, 'invalid_max_message_bytes'],
  [{ maxMessageBytes: 1.5 * 1024 * 1024 + 0.5 }, 'invalid_max_message_bytes'],
  [{ maxMessageBytes: 2 * 1024 * 1024 * 1024 }, 'invalid_max_message_bytes'],
  [{ maxBlobStorageBytes: 1024 }, 'invalid_max_blob_storage_bytes'],
  [{ maxBlobStorageBytes: 2 * 1024 ** 4 }, 'invalid_max_blob_storage_bytes'],
  [{ blossomServers: ['http://blossom.example.com'] }, 'invalid_blossom_servers'],
  [{ indexerRelays: ['wss://localhost'] }, 'invalid_indexer_relays'],
  [{ quotas: null }, 'invalid_quotas'],
  [{ quotas: { addresses: -1 } }, 'invalid_quotas'],
  [{ quotas: { mailboxes: 5 } }, 'invalid_quotas'],
])('refuses %j with %s', (body, error) => {
  expect(parseSettingsChanges(body)).toEqual({ error })
})
