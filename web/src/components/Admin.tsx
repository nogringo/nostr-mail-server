import { useEffect, useMemo, useState } from 'react'
import { type AdminDomain, type CheckStatus, createApi, type RecordCheck, type RecordId } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, plural, shortNpub, timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import { CopyButton, ErrorText } from './ui'

const RECORDS: [RecordId, string][] = [
  ['ownership', 'Ownership'],
  ['mx', 'MX'],
  ['https', 'A'],
  ['spf', 'SPF'],
  ['dkim', 'DKIM'],
  ['dmarc', 'DMARC'],
]

const TONES = { ok: 'text-ok', wait: 'text-wait', bad: 'text-bad', none: 'text-muted' }

type Tone = keyof typeof TONES

export default function Admin({ signer }: { signer: Signer }) {
  const api = useMemo(() => createApi(signer), [signer])
  const [domains, setDomains] = useState<AdminDomain[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listAllDomains().then(setDomains, (failure) => setError(describeError(failure)))
  }, [api])

  if (error) return <ErrorText>{error}</ErrorText>
  if (!domains) return null

  const verified = domains.filter((domain) => domain.verifiedAt)
  const pending = domains.filter((domain) => !domain.verifiedAt)
  const sending = verified.filter((domain) => domainStatus(domain).tone === 'ok').length
  const addresses = verified.reduce((total, domain) => total + domain.addressCount, 0)

  return (
    <>
      <h1 className="font-semibold text-3xl tracking-tight">Domains on this server</h1>
      <p className="mt-2 text-muted">
        {domains.length === 0
          ? 'No domain is connected yet.'
          : `${plural(verified.length, 'domain')} connected, ${sending} sending and receiving, ${plural(addresses, 'named address', 'named addresses')}.`}
      </p>
      {verified.length > 0 && <DomainList title="Connected" domains={verified} />}
      {pending.length > 0 && (
        <DomainList
          title="Not verified"
          note="Claims whose ownership record was never found. The first key whose record is found owns the domain, the other claims are then dropped."
          domains={pending}
        />
      )}
    </>
  )
}

function DomainList({ title, note, domains }: { title: string; note?: string; domains: AdminDomain[] }) {
  return (
    <section className="mt-10">
      <h2 className="font-medium">
        {title} <span className="font-normal text-muted">{domains.length}</span>
      </h2>
      {note && <p className="mt-1 text-muted text-sm">{note}</p>}
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {domains.map((domain) => (
          <DomainRow key={`${domain.domain} ${domain.pubkey}`} domain={domain} />
        ))}
      </ul>
    </section>
  )
}

function DomainRow({ domain }: { domain: AdminDomain }) {
  const status = domainStatus(domain)
  const npub = npubOf(domain.pubkey)

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="break-all font-medium">{domain.domain}</p>
        <p className={`text-sm ${TONES[status.tone]}`}>{status.text}</p>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted text-sm">
        <span className="flex items-center gap-1">
          <span className="font-mono">{shortNpub(npub)}</span>
          <CopyButton text={npub} label={`npub of the owner of ${domain.domain}`} />
        </span>
        {domain.verifiedAt && <span>{plural(domain.addressCount, 'named address', 'named addresses')}</span>}
        <span>claimed {timeAgo(domain.createdAt)}</span>
        {domain.checkedAt && <span>checked {timeAgo(domain.checkedAt)}</span>}
      </div>
      {domain.checks && <Records checks={domain.checks} />}
    </li>
  )
}

function Records({ checks }: { checks: Record<RecordId, RecordCheck> }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="DNS records at the last check">
      {RECORDS.map(([id, label]) => {
        const check = recordStatus(id, checks[id].status)
        const found = checks[id].found.join(', ')
        return (
          <li key={id} className={TONES[check.tone]} title={found ? `${check.text}: ${found}` : check.text}>
            <span aria-hidden="true">{check.glyph}</span> {label}
            <span className="sr-only">, {check.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function domainStatus(domain: AdminDomain): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.checks?.[id].status === 'ok'
  if (!domain.verifiedAt) return { tone: 'wait', text: domain.checkedAt ? 'Ownership not found' : 'Never checked' }
  if (!found('mx')) return { tone: 'wait', text: 'Verified, no MX record' }
  if (!found('https') || !found('spf') || !found('dkim')) return { tone: 'wait', text: 'Receiving only' }
  return { tone: 'ok', text: 'Sending and receiving' }
}

const CHECKS: Record<CheckStatus, { tone: Tone; text: string; glyph: string }> = {
  ok: { tone: 'ok', text: 'found', glyph: '✓' },
  missing: { tone: 'wait', text: 'missing', glyph: '○' },
  mismatch: { tone: 'bad', text: 'different value', glyph: '✗' },
  error: { tone: 'bad', text: 'lookup failed', glyph: '✗' },
}

// DMARC is recommended, not required.
function recordStatus(id: RecordId, status: CheckStatus) {
  const check = CHECKS[status]
  return id === 'dmarc' && status !== 'ok' ? { ...check, tone: 'none' as const } : check
}
