import { type DNSResolver, spf } from 'mailauth'
import { SMTP_LOCAL_PART } from './address.js'
import { SPF_TIME_LIMIT_MS } from './authentication.js'
import { normalizeHostname } from './domain.js'
import type {
  DnsLookup,
  DnsRecord,
  Domain,
  DomainChecks,
  DomainConfig,
  Nip05Lookup,
  RecordCheck,
  ServerRecord,
} from './types.js'

export const OWNERSHIP_LABEL = '_nostr-mail'
export const OWNERSHIP_PREFIX = 'nostr-mail-verification='

type RecordsConfig = Pick<DomainConfig, 'mxHost' | 'spfInclude' | 'publicIpv4'>

// Reserved by RFC 6761, so it never names a real domain.
const CONNECTED_DOMAIN = 'connected-domain.invalid'

// The records a domain needs: ownership proves the claim, MX receives mail,
// NIP-05 lets clients find its addresses and _smtp key, SPF and DKIM let it
// send. DMARC is recommended rather than required.
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
    domain.nip05 === 'server'
      ? { id: 'nip05', type: 'A', name, value: config.publicIpv4, required: true }
      : { id: 'nip05', type: 'NIP-05', name: `${SMTP_LOCAL_PART}@${name}`, value: domain.bridgePubkey, required: true },
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

export async function checkRecords(
  domain: Domain,
  config: RecordsConfig,
  dns: DnsLookup,
  nip05Lookup: Nip05Lookup,
): Promise<DomainChecks> {
  const name = domain.domain

  const [ownership, mx, nip05, spf, dkim, dmarc] = await Promise.all([
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
    settle(() =>
      domain.nip05 === 'server' ? checkPointsAt(dns, name, config.publicIpv4) : checkSmtpKey(nip05Lookup, domain),
    ),
    settle(async () => {
      // RFC 7208 3.2: more than one SPF record makes SPF fail, so it is a mismatch.
      const found = await spfRecords(dns, name)
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

  return { ownership, mx, nip05, spf, dkim, dmarc }
}

// What the server needs to receive and send for the connected domains: their MX
// host leads here, this address leads back to the name the server greets with,
// and the SPF record they include lets this address send.
export async function checkServerRecords(config: RecordsConfig, dns: DnsLookup): Promise<ServerRecord[]> {
  const { mxHost, spfInclude, publicIpv4 } = config

  const [host, ptr, spfCheck] = await Promise.all([
    settle(() => checkPointsAt(dns, mxHost, publicIpv4)),
    settle(async () => {
      const found = (await dns.reverse(publicIpv4)).map(normalizeHostname)
      return verdict(
        found,
        found.every((name) => name === mxHost),
      )
    }),
    settle(async () => {
      const [found, result] = await Promise.all([spfRecords(dns, spfInclude), evaluateSpfInclude(config, dns)])
      if (result === 'temperror') return { status: 'error', found }
      return verdict(found, result === 'pass')
    }),
  ])

  return [
    { id: 'host', type: 'A', name: mxHost, value: publicIpv4, check: host },
    { id: 'ptr', type: 'PTR', name: publicIpv4, value: mxHost, check: ptr },
    { id: 'spf', type: 'TXT', name: spfInclude, value: `v=spf1 ip4:${publicIpv4} -all`, check: spfCheck },
  ]
}

// Evaluated rather than compared, since a, mx or a wider ip4 range may list the
// address too. mailauth refuses to evaluate a name with an underscore label like
// _spf.example.com, so this evaluates what a connected domain publishes instead.
async function evaluateSpfInclude({ mxHost, spfInclude, publicIpv4 }: RecordsConfig, dns: DnsLookup) {
  const resolver: DNSResolver = async (name, rrtype) =>
    name === CONNECTED_DOMAIN && rrtype === 'TXT' ? [[`v=spf1 include:${spfInclude} -all`]] : dns.resolve(name, rrtype)

  const result = await spf({
    sender: `postmaster@${CONNECTED_DOMAIN}`,
    ip: publicIpv4,
    helo: mxHost,
    mta: mxHost,
    resolver,
    maxElapsedTime: SPF_TIME_LIMIT_MS,
  })
  return result.status.result
}

// PUBLIC_IPV4 is the only address the server knows as its own: an AAAA record is a mismatch.
async function checkPointsAt(dns: DnsLookup, name: string, address: string): Promise<RecordCheck> {
  const found = await dns.addresses(name)
  return verdict(
    found,
    found.every((other) => other === address),
  )
}

async function checkSmtpKey(lookup: Nip05Lookup, { domain, bridgePubkey }: Domain): Promise<RecordCheck> {
  const answer = await lookup(domain, SMTP_LOCAL_PART)
  if ('redirect' in answer) return { status: 'mismatch', found: [`Redirect to ${answer.redirect}`] }

  const found = answer.pubkey === null ? [] : [answer.pubkey]
  return verdict(found, answer.pubkey === bridgePubkey)
}

async function spfRecords(dns: DnsLookup, name: string): Promise<string[]> {
  return (await dns.txt(name)).filter((value) => /^v=spf1(\s|$)/i.test(value.trim()))
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

// A domain sends once its last check found SPF and DKIM: receivers would take
// its mail for spoofing otherwise, and the sending address would pay for it.
export function sendsMail({ checks }: Pick<Domain, 'checks'>): boolean {
  return checks?.spf.status === 'ok' && checks.dkim.status === 'ok'
}
