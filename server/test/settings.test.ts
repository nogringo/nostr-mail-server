import { expect, test } from 'vitest'
import { parseSettingsChanges } from '../src/settings.js'
import { MemoryDomainRepository, settingsStore } from './helpers.js'

const DAY_MS = 24 * 3600_000

test('a removed domain relay is still listened to for seven days', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, { domainRelays: ['wss://old.example.org/', 'wss://kept.example.org/'] })
  const now = Date.parse('2026-10-21T12:00:00Z')

  await settings.update({ domainRelays: ['wss://kept.example.org/', 'wss://new.example.org/'] }, now)

  expect(settings.current.domainRelays).toEqual(['wss://kept.example.org/', 'wss://new.example.org/'])
  expect(settings.outboxRelays(now + 6 * DAY_MS)).toEqual([
    'wss://kept.example.org/',
    'wss://new.example.org/',
    'wss://old.example.org/',
  ])
  expect(settings.outboxRelays(now + 8 * DAY_MS)).toEqual(['wss://kept.example.org/', 'wss://new.example.org/'])
  expect(repo.storedSettings.retiredDomainRelays).toEqual({ 'wss://old.example.org/': '2026-10-28T12:00:00.000Z' })
})

test('a relay put back is no longer retired, and expired ones are dropped', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo, { domainRelays: ['wss://a.example.org/', 'wss://b.example.org/'] })
  const now = Date.parse('2026-10-21T12:00:00Z')
  await settings.update({ domainRelays: ['wss://c.example.org/'] }, now)

  await settings.update({ domainRelays: ['wss://a.example.org/'] }, now + 8 * DAY_MS)

  expect(repo.storedSettings.retiredDomainRelays).toEqual({ 'wss://c.example.org/': '2026-11-05T12:00:00.000Z' })
})

test('changing another setting keeps the relays and returns the settings without the retired ones', async () => {
  const repo = new MemoryDomainRepository()
  const settings = settingsStore(repo)

  const updated = await settings.update({ openRegistration: true })

  expect(updated).toEqual({ ...settings.current, openRegistration: true })
  expect(updated).not.toHaveProperty('retiredDomainRelays')
  expect(repo.storedSettings.retiredDomainRelays).toEqual({})
})

test('parses the settings an admin changes, URLs normalized and once each', () => {
  expect(
    parseSettingsChanges({
      openRegistration: true,
      maxMessageBytes: 10 * 1024 * 1024,
      blossomServers: ['https://Blossom.Example.com/', 'https://blossom.example.com'],
      domainRelays: ['wss://Relay.Example.com'],
      indexerRelays: [' wss://indexer.example.com/ '],
    }),
  ).toEqual({
    changes: {
      openRegistration: true,
      maxMessageBytes: 10 * 1024 * 1024,
      blossomServers: ['https://blossom.example.com'],
      domainRelays: ['wss://relay.example.com/'],
      indexerRelays: ['wss://indexer.example.com/'],
    },
  })
  expect(parseSettingsChanges({})).toEqual({ changes: {} })
})

test.each([
  [null, 'invalid_settings'],
  [[], 'invalid_settings'],
  [{ openRegistration: 'true' }, 'invalid_open_registration'],
  [{ maxMessageBytes: 1024 }, 'invalid_max_message_bytes'],
  [{ maxMessageBytes: 1.5 * 1024 * 1024 + 0.5 }, 'invalid_max_message_bytes'],
  [{ maxMessageBytes: 2 * 1024 * 1024 * 1024 }, 'invalid_max_message_bytes'],
  [{ blossomServers: ['http://blossom.example.com'] }, 'invalid_blossom_servers'],
  [{ domainRelays: [] }, 'invalid_domain_relays'],
  [{ domainRelays: 'wss://relay.example.com' }, 'invalid_domain_relays'],
  [{ indexerRelays: ['wss://localhost'] }, 'invalid_indexer_relays'],
])('refuses %j with %s', (body, error) => {
  expect(parseSettingsChanges(body)).toEqual({ error })
})
