import { normalizeHostname } from './domain.js'
import type { DnsLookup, DnsRecord, Domain, DomainChecks, DomainConfig, RecordCheck } from './types.js'

export const OWNERSHIP_LABEL = '_nostr-mail'
export const OWNERSHIP_PREFIX = 'nostr-mail-verification='

type RecordsConfig = Pick<DomainConfig, 'mxHost' | 'spfInclude' | 'publicIpv4'>

// The records a domain needs: ownership proves the claim, MX receives mail, A
// brings its HTTPS (NIP-05) here, SPF and DKIM let it send. DMARC is
// recommended rather than required.
export function expectedRecords(domain: Domain, config: RecordsConfig): DnsRecord[] {
  const name = domain.domain
  return [
    {
      id: 'ownership',
      type: 'TXT',
      name: `${OWNERSHIP_LABEL}.${name}`,
      value: OWNERSHIP_PREFIX + domain.verificationToken,
      required: true,
    },
    { id: 'mx', type: 'MX', name, value: config.mxHost, priority: 10, required: true },
    { id: 'https', type: 'A', name, value: config.publicIpv4, required: true },
    { id: 'spf', type: 'TXT', name, value: `v=spf1 include:${config.spfInclude} ~all`, required: true },
    {
      id: 'dkim',
      type: 'TXT',
      name: `${domain.dkimSelector}._domainkey.${name}`,
      value: `v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`,
      required: true,
    },
    { id: 'dmarc', type: 'TXT', name: `_dmarc.${name}`, value: 'v=DMARC1; p=none', required: false },
  ]
}

export async function checkRecords(domain: Domain, config: RecordsConfig, dns: DnsLookup): Promise<DomainChecks> {
  const name = domain.domain

  const [ownership, mx, https, spf, dkim, dmarc] = await Promise.all([
    settle(async () => {
      const found = await dns.txt(`${OWNERSHIP_LABEL}.${name}`)
      const expected = OWNERSHIP_PREFIX + domain.verificationToken
      return verdict(
        found,
        found.some((value) => value.trim() === expected),
      )
    }),
    settle(async () => {
      const records = await dns.mx(name)
      const found = records.map((record) => `${record.priority} ${normalizeHostname(record.exchange)}`)
      return verdict(
        found,
        records.every((record) => normalizeHostname(record.exchange) === config.mxHost),
      )
    }),
    settle(async () => {
      // HTTPS is served on IPv4 only: an AAAA record sends IPv6 clients elsewhere.
      const found = await dns.addresses(name)
      return verdict(
        found,
        found.every((address) => address === config.publicIpv4),
      )
    }),
    settle(async () => {
      // RFC 7208 3.2: more than one SPF record makes SPF fail, so it is a mismatch.
      const found = (await dns.txt(name)).filter((value) => /^v=spf1(\s|$)/i.test(value.trim()))
      return verdict(found, found.length === 1 && hasSpfInclude(found[0], config.spfInclude))
    }),
    settle(async () => {
      const found = await dns.txt(`${domain.dkimSelector}._domainkey.${name}`)
      return verdict(
        found,
        found.some((value) => dkimPublicKey(value) === domain.dkimPublicKey),
      )
    }),
    settle(async () => {
      const found = (await dns.txt(`_dmarc.${name}`)).filter((value) => /^v=DMARC1\s*(;|$)/i.test(value.trim()))
      return verdict(found, found.length === 1)
    }),
  ])

  return { ownership, mx, https, spf, dkim, dmarc }
}

async function settle(run: () => Promise<RecordCheck>): Promise<RecordCheck> {
  try {
    return await run()
  } catch {
    return { status: 'error', found: [] }
  }
}

function verdict(found: string[], ok: boolean): RecordCheck {
  return { status: found.length === 0 ? 'missing' : ok ? 'ok' : 'mismatch', found }
}

function hasSpfInclude(record: string, include: string): boolean {
  return record
    .toLowerCase()
    .split(/\s+/)
    .some((term) => term.replace(/^\+/, '') === `include:${include}`)
}

function dkimPublicKey(record: string): string | undefined {
  for (const tag of record.split(';')) {
    const [key, ...value] = tag.split('=')
    if (key.trim() === 'p') return value.join('=').replace(/\s+/g, '')
  }

  return undefined
}
