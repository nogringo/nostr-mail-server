import { nip19 } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { expect, test } from 'vitest'
import { isEncryptedKey, isSecretKey, signInWithKey } from '../src/lib/signer'

const secretKey = generateSecretKey()
const pubkey = getPublicKey(secretKey)

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
