import { generateKeyPair } from 'node:crypto'
import { promisify } from 'node:util'

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
