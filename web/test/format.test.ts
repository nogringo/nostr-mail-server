import { expect, test } from 'vitest'
import { byteSize, plural, shortNpub, timeAgo } from '../src/lib/format'

test('shortens an npub to its start and end', () => {
  expect(shortNpub('npub1qy3qv9jtu7yfm0qnzv9x3n4v6pk0a8xfd7rm6ts2s0l4nx5ewjrq5p8f2k')).toBe('npub1qy3qv...8f2k')
})

test('writes how long ago a check ran', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')

  expect(timeAgo('2026-10-20T11:59:30Z', now)).toBe('just now')
  expect(timeAgo('2026-10-20T11:55:00Z', now)).toBe('5 minutes ago')
  expect(timeAgo('2026-10-20T09:00:00Z', now)).toBe('3 hours ago')
  expect(timeAgo('2026-10-19T12:00:00Z', now)).toBe('yesterday')
})

test('writes a count with its noun', () => {
  expect(plural(1, 'domain')).toBe('1 domain')
  expect(plural(0, 'domain')).toBe('0 domains')
  expect(plural(3, 'address', 'addresses')).toBe('3 addresses')
})

test('writes the size of a message', () => {
  expect(byteSize(200)).toBe('1 kB')
  expect(byteSize(48_000)).toBe('47 kB')
  expect(byteSize(25 * 1024 * 1024)).toBe('25 MB')
})
