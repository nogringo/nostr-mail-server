import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { isKnownAdmin, rememberAdmin } from '../src/lib/admins'

beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('remembers the keys that opened the admin page', () => {
  rememberAdmin('alice', true)
  rememberAdmin('bob', true)
  rememberAdmin('alice', false)

  expect(isKnownAdmin('alice')).toBe(false)
  expect(isKnownAdmin('bob')).toBe(true)
})

test('knows no admin when the browser keeps no storage', () => {
  vi.stubGlobal('localStorage', undefined)

  expect(() => rememberAdmin('alice', true)).not.toThrow()
  expect(isKnownAdmin('alice')).toBe(false)
})
