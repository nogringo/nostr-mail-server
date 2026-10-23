import { expect, test } from 'vitest'
import { byteSize, shortNpub, timeAgo } from '../src/lib/format'

test('shortens an npub to its start and end', () => {
  expect(shortNpub('npub1qy3qv9jtu7yfm0qnzv9x3n4v6pk0a8xfd7rm6ts2s0l4nx5ewjrq5p8f2k')).toBe('npub1qy3qv...8f2k')
})

test('writes how long ago a check ran', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')

  expect(timeAgo('2026-10-20T11:59:30Z', 'en', now)).toBe('just now')
  expect(timeAgo('2026-10-20T11:55:00Z', 'en', now)).toBe('5 minutes ago')
  expect(timeAgo('2026-10-20T09:00:00Z', 'en', now)).toBe('3 hours ago')
  expect(timeAgo('2026-10-19T12:00:00Z', 'en', now)).toBe('yesterday')
})

test('writes how long ago in French', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')

  expect(timeAgo('2026-10-20T11:59:30Z', 'fr', now)).toBe("à l'instant")
  expect(timeAgo('2026-10-20T11:55:00Z', 'fr', now)).toBe('il y a 5 minutes')
  expect(timeAgo('2026-10-19T12:00:00Z', 'fr', now)).toBe('hier')
})

test('writes the size of a message', () => {
  expect(byteSize(200, 'en')).toBe('1 kB')
  expect(byteSize(48_000, 'en')).toBe('47 kB')
  expect(byteSize(25 * 1024 * 1024, 'en')).toBe('25 MB')
  expect(byteSize(48_000, 'fr')).toBe('47 ko')
})
