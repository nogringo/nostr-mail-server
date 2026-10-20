import { expect, test } from 'vitest'
import { shortNpub, timeAgo } from '../src/lib/format'

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
