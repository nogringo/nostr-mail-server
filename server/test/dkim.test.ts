import { createPublicKey, sign, verify } from 'node:crypto'
import { dkimVerify } from 'mailauth'
import { expect, test } from 'vitest'
import { generateDkimKeyPair, signMessage } from '../src/dkim.js'
import { FakeAuthDns } from './helpers.js'

test('generateDkimKeyPair returns a matching 2048-bit RSA pair', async () => {
  const { publicKey, privateKey } = await generateDkimKeyPair()

  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  expect(key.asymmetricKeyType).toBe('rsa')
  expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048)

  const data = Buffer.from('dkim-signature')
  expect(verify('sha256', data, key, sign('sha256', data, privateKey))).toBe(true)
})

test('signMessage prepends a signature that verifies against the published key', async () => {
  const { publicKey, privateKey } = await generateDkimKeyPair()
  const dns = new FakeAuthDns()
  dns.txtRecords.set('nostrmail._domainkey.example.com', [`v=DKIM1; k=rsa; p=${publicKey}`])
  const message = Buffer.from('From: alice@example.com\r\nTo: bob@remote.example\r\nSubject: Hi\r\n\r\nHello\r\n')

  const signed = await signMessage(message, {
    domain: 'example.com',
    dkimSelector: 'nostrmail',
    dkimPrivateKey: privateKey,
  })

  expect(signed.toString()).toMatch(/^DKIM-Signature: .*d=example\.com;/)
  expect(signed.subarray(-message.length).equals(message)).toBe(true)
  const { results } = await dkimVerify(signed, { resolver: dns.resolve })
  expect(results.map((result) => result.status.result)).toEqual(['pass'])
})
