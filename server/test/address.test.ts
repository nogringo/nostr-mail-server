import { npubEncode } from 'nostr-tools/nip19'
import { expect, test } from 'vitest'
import { isReservedLocalPart, normalizeLocalPart, parseEmailAddress } from '../src/address.js'

const NPUB = npubEncode('a'.repeat(64))

test('normalizeLocalPart lowercases and keeps NIP-05 characters', () => {
  expect(normalizeLocalPart(' Alice ')).toBe('alice')
  expect(normalizeLocalPart('first.last')).toBe('first.last')
  expect(normalizeLocalPart('a-b_c')).toBe('a-b_c')
  expect(normalizeLocalPart('_')).toBe('_')
  expect(normalizeLocalPart(NPUB)).toBe(NPUB)
})

test.each(['', 'a..b', '.alice', 'alice.', 'a b', 'alice+tag', 'élodie', 'a@b', 'a'.repeat(65)])(
  'normalizeLocalPart rejects %j',
  (value) => {
    expect(normalizeLocalPart(value)).toBeNull()
  },
)

test('_smtp and npub local parts are reserved', () => {
  for (const name of ['_smtp', NPUB, 'npub1typo']) {
    expect(isReservedLocalPart(name), name).toBe(true)
  }
  for (const name of ['alice', '_', 'smtp', 'a'.repeat(64)]) {
    expect(isReservedLocalPart(name), name).toBe(false)
  }
})

test('parseEmailAddress splits and normalizes an address', () => {
  expect(parseEmailAddress('Bob@Example.COM')).toEqual({ localPart: 'bob', domain: 'example.com' })
  expect(parseEmailAddress('bob@bücher.de')).toEqual({ localPart: 'bob', domain: 'xn--bcher-kva.de' })
})

test.each(['', 'bob', '@example.com', 'bob@', 'bob@localhost', 'a..b@example.com'])(
  'parseEmailAddress rejects %j',
  (value) => {
    expect(parseEmailAddress(value)).toBeNull()
  },
)
