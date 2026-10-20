import assert from 'node:assert/strict'
import { createPublicKey, sign, verify } from 'node:crypto'
import test from 'node:test'
import { generateDkimKeyPair } from '../src/dkim.js'

test('generateDkimKeyPair returns a matching 2048-bit RSA pair', async () => {
  const { publicKey, privateKey } = await generateDkimKeyPair()

  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  assert.equal(key.asymmetricKeyType, 'rsa')
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048)

  const data = Buffer.from('dkim-signature')
  assert.ok(verify('sha256', data, key, sign('sha256', data, privateKey)))
})
