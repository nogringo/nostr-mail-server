import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  type AdminDomain,
  type AdminOverview,
  type CheckStatus,
  createApi,
  type RecordCheck,
  type RecordId,
  type Suspension,
} from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, plural, shortNpub, timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import AbuseReportRow from './AbuseReportRow'
import { Button, CopyButton, ErrorText } from './ui'

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
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.adminOverview().then(setOverview, (failure) => setError(describeError(failure)))
  }, [api])

  if (error) return <ErrorText>{error}</ErrorText>
  if (!overview) return null

  async function suspend(name: string) {
    const suspension = await api.suspendDomain(name)
    setOverview(
      (current) =>
        current && {
          ...current,
          suspensions: [...current.suspensions.filter((other) => other.domain !== name), suspension].sort(
            (left, right) => left.domain.localeCompare(right.domain),
          ),
        },
    )
  }

  async function lift(name: string) {
    await api.liftSuspension(name)
    setOverview(
      (current) => current && { ...current, suspensions: current.suspensions.filter((other) => other.domain !== name) },
    )
  }

  const { domains, suspensions, abuseReports } = overview
  const suspended = new Set(suspensions.map((suspension) => suspension.domain))
  const served = domains.filter((domain) => !suspended.has(domain.domain))
  const verified = served.filter((domain) => domain.verifiedAt)
  const pending = served.filter((domain) => !domain.verifiedAt)
  const sending = verified.filter((domain) => domainStatus(domain).tone === 'ok').length
  const addresses = verified.reduce((total, domain) => total + domain.addressCount, 0)

  return (
    <>
      <h1 className="font-semibold text-3xl tracking-tight">Domains on this server</h1>
      <p className="mt-2 text-muted">
        {domains.length === 0 && suspensions.length === 0
          ? 'No domain is connected yet.'
          : `${plural(verified.length, 'domain')} connected, ${sending} sending and receiving${suspensions.length ? `, ${suspensions.length} suspended` : ''}. ${plural(addresses, 'named address', 'named addresses')}.`}
      </p>
      {verified.length > 0 && (
        <Section title="Connected" count={verified.length}>
          {verified.map((domain) => (
            <DomainRow key={`${domain.domain} ${domain.pubkey}`} domain={domain} onSuspend={suspend} />
          ))}
        </Section>
      )}
      {pending.length > 0 && (
        <Section
          title="Not verified"
          count={pending.length}
          note="Claims whose ownership record was never found. The first key whose record is found owns the domain, the other claims are then dropped."
        >
          {pending.map((domain) => (
            <DomainRow key={`${domain.domain} ${domain.pubkey}`} domain={domain} onSuspend={suspend} />
          ))}
        </Section>
      )}
      {suspensions.length > 0 && (
        <Section
          title="Suspended"
          count={suspensions.length}
          note="The server neither receives, sends nor serves NIP-05 for these domains, and no key can claim them. Their abuse@ still reaches you and is kept below."
        >
          {suspensions.map((suspension) => (
            <SuspendedRow
              key={suspension.domain}
              suspension={suspension}
              claims={domains.filter((domain) => domain.domain === suspension.domain)}
              onLift={lift}
            />
          ))}
        </Section>
      )}
      {abuseReports.length > 0 && (
        <Section
          title="Abuse reports"
          count={abuseReports.length}
          note="Mail sent to abuse@ of the domains, newest first. Their owners get it too."
        >
          {abuseReports.map((report) => (
            <AbuseReportRow key={report.id} report={report} load={() => api.adminAbuseMessage(report.id)} showDomain />
          ))}
        </Section>
      )}
    </>
  )
}

function Section({
  title,
  count,
  note,
  children,
}: {
  title: string
  count: number
  note?: string
  children: ReactNode
}) {
  return (
    <section className="mt-10">
      <h2 className="font-medium">
        {title} <span className="font-normal text-muted">{count}</span>
      </h2>
      {note && <p className="mt-1 text-muted text-sm">{note}</p>}
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">{children}</ul>
    </section>
  )
}

function DomainRow({ domain, onSuspend }: { domain: AdminDomain; onSuspend: (name: string) => Promise<void> }) {
  const status = domainStatus(domain)

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="break-all font-medium">{domain.domain}</p>
        <p className={`text-sm ${TONES[status.tone]}`}>{status.text}</p>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted text-sm">
        <Owner domain={domain} />
        {domain.verifiedAt && <span>{plural(domain.addressCount, 'named address', 'named addresses')}</span>}
        <span>claimed {timeAgo(domain.createdAt)}</span>
        {domain.checkedAt && <span>checked {timeAgo(domain.checkedAt)}</span>}
      </div>
      {domain.checks && <Records checks={domain.checks} />}
      <SuspendAction name={domain.domain} onSuspend={onSuspend} />
    </li>
  )
}

function SuspendedRow({
  suspension,
  claims,
  onLift,
}: {
  suspension: Suspension
  claims: AdminDomain[]
  onLift: (name: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function lift() {
    setBusy(true)
    setError(null)
    try {
      await onLift(suspension.domain)
    } catch (failure) {
      setError(describeError(failure))
      setBusy(false)
    }
  }

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="break-all font-medium">{suspension.domain}</p>
        <p className="text-bad text-sm">Suspended {timeAgo(suspension.suspendedAt)}</p>
      </div>
      {claims.length === 0 && <p className="mt-1 text-muted text-sm">No key claims it.</p>}
      {claims.map((claim) => (
        <div key={claim.pubkey} className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted text-sm">
          <Owner domain={claim} />
          <span>
            {claim.verifiedAt
              ? `verified, ${plural(claim.addressCount, 'named address', 'named addresses')}`
              : 'not verified'}
          </span>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <Button variant="quiet" onClick={lift} disabled={busy}>
          {busy ? 'Lifting' : 'Lift suspension'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </li>
  )
}

function SuspendAction({ name, onSuspend }: { name: string; onSuspend: (name: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function suspend() {
    setBusy(true)
    setError(null)
    try {
      await onSuspend(name)
    } catch (failure) {
      setError(describeError(failure))
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {confirming ? (
        <>
          <span>Suspend {name}? It stops receiving and sending mail at once, whichever key claims it.</span>
          <Button variant="quiet" className="text-bad" onClick={suspend} disabled={busy}>
            {busy ? 'Suspending' : 'Suspend'}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="quiet" onClick={() => setConfirming(true)}>
          Suspend domain
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function Owner({ domain }: { domain: AdminDomain }) {
  const npub = npubOf(domain.pubkey)
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono">{shortNpub(npub)}</span>
      <CopyButton text={npub} label={`npub of the key that claims ${domain.domain}`} />
    </span>
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
