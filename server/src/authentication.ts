import { type AuthenticateResult, authenticate, type DNSResolver } from 'mailauth'
import { splitHeader } from './mime.js'

// RFC 7208 4.6.4: an SPF evaluation may be cut off once it takes more than 20 seconds.
const SPF_TIME_LIMIT_MS = 20_000
const AUTHENTICATION_RESULTS = /^authentication-results[ \t]*:/i

export interface DmarcRejection {
  domain: string
  // SPF or a DKIM signature could not be looked up, so the message may pass on a retry.
  temporary: boolean
}

export interface Connection {
  ip: string
  helo: string
  mailFrom: string
}

// SPF, DKIM and DMARC of the message as received, reported under the server's name.
export function authenticateMessage(
  message: Buffer,
  { ip, helo, mailFrom }: Connection,
  mxHost: string,
  resolver: DNSResolver,
): Promise<AuthenticateResult> {
  return authenticate(message, {
    ip,
    helo,
    sender: mailFrom,
    mta: mxHost,
    resolver,
    // BIMI picks a logo to display, it does not authenticate anything.
    disableBimi: true,
    maxElapsedTime: SPF_TIME_LIMIT_MS,
  })
}

// RFC 9989: an author domain publishing p=reject asks receivers to refuse what fails DMARC.
export function dmarcRejection({ dmarc, spf, dkim }: AuthenticateResult): DmarcRejection | null {
  if (dmarc === false || dmarc.status.result !== 'fail' || dmarc.policy !== 'reject') return null

  const results = [...(spf ? [spf.status.result] : []), ...dkim.results.map((result) => result.status.result)]
  return { domain: dmarc.status.header?.from ?? dmarc.domain, temporary: results.includes('temperror') }
}

export function summarize({ spf, dkim, dmarc }: AuthenticateResult) {
  return {
    spf: spf ? spf.status.result : 'none',
    dkim: dkim.results.map((result) => result.status.result),
    dmarc: dmarc ? dmarc.status.result : 'none',
  }
}

// RFC 8601 5: results that arrive with the message under this server's name are forged.
export function removeForgedResults(message: Buffer, authservId: string): Buffer {
  const { fields, rest } = splitHeader(message)
  const kept = fields.filter((field) => authservIdOf(field) !== authservId)
  if (kept.length === fields.length) return message

  return Buffer.from(kept.join('') + rest, 'latin1')
}

function authservIdOf(field: string): string | null {
  if (!AUTHENTICATION_RESULTS.test(field)) return null

  const value = field.slice(field.indexOf(':') + 1).replace(/\([^)]*\)/g, ' ')
  return value.trim().split(/[\s;]/, 1)[0].toLowerCase()
}
