import { createPublicKey, sign, verify } from 'node:crypto'
import { expect, test } from 'vitest'
import { generateDkimKeyPair } from '../src/dkim.js'

test('generateDkimKeyPair returns a matching 2048-bit RSA pair', async () => {
  const { publicKey, privateKey } = await generateDkimKeyPair()

  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  expect(key.asymmetricKeyType).toBe('rsa')
  expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048)

  const data = Buffer.from('dkim-signature')
  expect(verify('sha256', data, key, sign('sha256', data, privateKey))).toBe(true)
})
