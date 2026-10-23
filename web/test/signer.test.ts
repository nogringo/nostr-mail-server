import { nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { type EventTemplate, finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  isEncryptedKey,
  isSecretKey,
  listAccounts,
  restoreSession,
  signInWithExtension,
  signInWithKey,
  signOut,
  switchAccount,
} from '../src/lib/signer'

const secretKey = generateSecretKey()
const pubkey = getPublicKey(secretKey)

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  } as unknown as Storage
}

function extensionWith(key: Uint8Array): void {
  vi.stubGlobal('window', {
    nostr: {
      getPublicKey: async () => getPublicKey(key),
      signEvent: async (event: EventTemplate) => finalizeEvent(event, key),
    },
  })
}

function signInWith(key: Uint8Array) {
  return signInWithKey(nip19.nsecEncode(key), '')
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('signs in with an nsec and signs events with it', async () => {
  const signer = await signInWithKey(` ${nip19.nsecEncode(secretKey)} `, '')

  expect(signer.pubkey).toBe(pubkey)
  const event = await signer.signEvent({ kind: 27235, tags: [], content: '', created_at: 1 })
  expect(event.pubkey).toBe(pubkey)
  expect(verifyEvent(event)).toBe(true)
})

test('signs in with an ncryptsec and its password', async () => {
  const ncryptsec = nip49.encrypt(secretKey, 'correct horse', 8)

  expect(isEncryptedKey(ncryptsec)).toBe(true)
  expect((await signInWithKey(ncryptsec, 'correct horse')).pubkey).toBe(pubkey)
  await expect(signInWithKey(ncryptsec, 'wrong horse')).rejects.toThrow('wrong_password')
})

test('tells a secret key from a bunker as soon as its prefix is typed', () => {
  expect(isSecretKey(' nsec1')).toBe(true)
  expect(isSecretKey('ncryptsec1q')).toBe(true)
  expect(isSecretKey('bunker://abc?relay=wss://relay.example')).toBe(false)
  expect(isSecretKey('nsec@example.com')).toBe(false)
})

test('refuses anything else than an nsec or an ncryptsec', async () => {
  expect(isEncryptedKey(nip19.nsecEncode(secretKey))).toBe(false)
  await expect(signInWithKey(nip19.npubEncode(pubkey), '')).rejects.toThrow('invalid_secret_key')
  await expect(signInWithKey('nsec1notakey', '')).rejects.toThrow('invalid_secret_key')
})

test('keeps every account signed in and opens the last one picked', async () => {
  const other = generateSecretKey()
  await signInWith(secretKey)
  await signInWith(other)

  expect(listAccounts().map((account) => account.pubkey)).toEqual([pubkey, getPublicKey(other)])
  expect((await restoreSession())?.pubkey).toBe(getPublicKey(other))
  expect((await switchAccount(pubkey)).pubkey).toBe(pubkey)
  expect((await restoreSession())?.pubkey).toBe(pubkey)
})

test('opens the account a page prefers without picking it for the other pages', async () => {
  const admin = generateSecretKey()
  await signInWith(admin)
  await signInWith(secretKey)

  expect((await restoreSession((key) => key === getPublicKey(admin)))?.pubkey).toBe(getPublicKey(admin))
  expect((await restoreSession())?.pubkey).toBe(pubkey)
})

test('signs out of one account and opens the next one', async () => {
  const other = generateSecretKey()
  await signInWith(other)
  await signOut(await signInWith(secretKey))

  expect(listAccounts().map((account) => account.pubkey)).toEqual([getPublicKey(other)])
  expect((await restoreSession())?.pubkey).toBe(getPublicKey(other))
  await expect(switchAccount(pubkey)).rejects.toThrow('account_signed_out')
})

test('keeps a secret key for new tabs and lets each tab pick its own account', async () => {
  const other = generateSecretKey()
  await signInWith(secretKey)
  await signInWith(other)
  const firstTab = sessionStorage

  vi.stubGlobal('sessionStorage', memoryStorage())
  expect(listAccounts()).toEqual([
    { method: 'key', pubkey },
    { method: 'key', pubkey: getPublicKey(other) },
  ])
  expect((await restoreSession())?.pubkey).toBe(getPublicKey(other))
  await switchAccount(pubkey)

  vi.stubGlobal('sessionStorage', firstTab)
  expect((await restoreSession())?.pubkey).toBe(getPublicKey(other))
})

test('holds one extension account, the one selected in the extension', async () => {
  extensionWith(secretKey)
  await signInWithExtension()
  const other = generateSecretKey()
  extensionWith(other)

  expect((await restoreSession())?.pubkey).toBe(getPublicKey(other))
  expect(listAccounts()).toEqual([{ method: 'extension', pubkey: getPublicKey(other) }])
  await signInWithExtension()
  expect(listAccounts()).toHaveLength(1)
})
