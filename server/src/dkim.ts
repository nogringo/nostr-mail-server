import { generateKeyPair } from 'node:crypto'
import { promisify } from 'node:util'
import { dkimSign } from 'mailauth'
import type { Domain } from './types.js'

const generateKeyPairAsync = promisify(generateKeyPair)

export interface DkimKeyPair {
  // Base64 SubjectPublicKeyInfo, the `p=` tag of the DKIM record (RFC 6376 3.6.1).
  publicKey: string
  // PKCS#8 PEM, the format rspamd and Haraka load.
  privateKey: string
}

export async function generateDkimKeyPair(): Promise<DkimKeyPair> {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  return { publicKey: publicKey.toString('base64'), privateKey }
}

// Prepends the domain's DKIM-Signature, relaxed/relaxed over the default header set.
export async function signMessage(
  message: Buffer,
  { domain, dkimSelector, dkimPrivateKey }: Pick<Domain, 'domain' | 'dkimSelector' | 'dkimPrivateKey'>,
): Promise<Buffer> {
  const { signatures, errors } = await dkimSign(message, {
    signatureData: [{ signingDomain: domain, selector: dkimSelector, privateKey: dkimPrivateKey }],
  })
  if (!signatures) throw new Error(`DKIM signing failed: ${errors.map(({ err }) => err.message).join(', ')}`)

  return Buffer.concat([Buffer.from(signatures), message])
}
