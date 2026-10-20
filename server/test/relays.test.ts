import { finalizeEvent } from 'nostr-tools/pure'
import { expect, test } from 'vitest'
import { normalizeRelayUrl } from '../src/nostr.js'
import { dmRelaysOf, latest, writeRelaysOf } from '../src/relays.js'
import { signer } from './helpers.js'

const alice = signer()

function list(kind: number, tags: string[][], createdAt = 1000, sk = alice.sk) {
  return finalizeEvent({ kind, tags, content: '', created_at: createdAt }, sk)
}

test('normalizeRelayUrl keeps public wss:// relays only', () => {
  expect(normalizeRelayUrl(' wss://Relay.Example.com ')).toBe('wss://relay.example.com/')
  for (const url of [
    'ws://relay.example.com',
    'https://relay.example.com',
    'wss://localhost',
    'wss://relay.localhost',
    'wss://127.0.0.1',
    'wss://[::1]',
    'wss://intranet',
    'not a url',
  ]) {
    expect(normalizeRelayUrl(url), url).toBeNull()
  }
})

test('latest returns the newest list of the kind written by the pubkey', () => {
  const old = list(10050, [['relay', 'wss://old.example']], 1000)
  const recent = list(10050, [['relay', 'wss://new.example']], 2000)
  const forged = list(10050, [['relay', 'wss://evil.example']], 3000, signer().sk)
  const other = list(10002, [['r', 'wss://outbox.example']], 4000)

  expect(latest([old, forged, recent, other], 10050, alice.pubkey)).toBe(recent)
  expect(latest([forged], 10050, alice.pubkey)).toBeUndefined()
})

test('dmRelaysOf normalizes, filters, dedupes and caps the relays', () => {
  const dmList = list(10050, [
    ['relay', 'wss://Inbox.example.com/'],
    ['relay', 'wss://inbox.example.com'],
    ['relay', 'ws://plain.example.com'],
    ['relay', 'wss://127.0.0.1'],
    ['relay'],
    ...Array.from({ length: 10 }, (_, index) => ['relay', `wss://relay${index}.example.com`]),
  ])

  const relays = dmRelaysOf(dmList)

  expect(relays[0]).toBe('wss://inbox.example.com/')
  expect(relays).toHaveLength(8)
  expect(relays.some((relay) => relay.includes('plain') || relay.includes('127.0.0.1'))).toBe(false)
})

test('writeRelaysOf skips the read-only relays', () => {
  const relayList = list(10002, [
    ['r', 'wss://both.example.com'],
    ['r', 'wss://write.example.com', 'write'],
    ['r', 'wss://read.example.com', 'read'],
  ])

  expect(writeRelaysOf(relayList)).toEqual(['wss://both.example.com/', 'wss://write.example.com/'])
})
