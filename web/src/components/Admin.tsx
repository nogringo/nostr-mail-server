import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useLocale, useMessages } from '../i18n'
import type { Messages } from '../i18n/en'
import { rememberAdmin } from '../lib/admins'
import {
  type AdminDomain,
  type AdminOverview,
  type Api,
  ApiError,
  type CheckStatus,
  createApi,
  type Quotas,
  type RecordCheck,
  type RecordId,
  type ServerRecord,
  type SettingsChanges,
  type Suspension,
} from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub, timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import AbuseReportRow from './AbuseReportRow'
import AllowedKeys from './AllowedKeys'
import QuotaSettings from './QuotaSettings'
import RecordRow from './RecordRow'
import ServiceSettings from './ServiceSettings'
import { type TabLink, Tabs, useHash } from './Tabs'
import { Button, CopyButton, ErrorText, TONES, type Tone } from './ui'

type Tab = 'domains' | 'access' | 'quotas' | 'suspended' | 'abuse' | 'server' | 'settings'

const RECORDS: RecordId[] = ['ownership', 'mx', 'nip05', 'spf', 'dkim', 'dmarc']

export default function Admin({ signer }: { signer: Signer }) {
  const t = useMessages()
  const api = useMemo(() => createApi(signer), [signer])
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.adminOverview().then(
      (loaded) => {
        rememberAdmin(signer.pubkey, true)
        setOverview(loaded)
      },
      (failure) => {
        if (failure instanceof ApiError && failure.code === 'not_admin') rememberAdmin(signer.pubkey, false)
        setError(describeError(failure, t.errors))
      },
    )
  }, [api, signer.pubkey, t])

  return (
    <div className="pt-10 sm:pt-16">
      <ErrorText>{error}</ErrorText>
      {overview && <Overview initial={overview} api={api} />}
    </div>
  )
}

function Overview({ initial, api }: { initial: AdminOverview; api: Api }) {
  const t = useMessages()
  const [overview, setOverview] = useState(initial)
  // Picked once, like the tab of a domain's page.
  const [opening] = useState<Tab>(() => (problemsIn(initial.serverRecords) > 0 ? 'server' : 'domains'))
  const hash = useHash()

  async function suspend(name: string) {
    const suspension = await api.suspendDomain(name)
    setOverview((current) => ({
      ...current,
      suspensions: [...current.suspensions.filter((other) => other.domain !== name), suspension].sort((left, right) =>
        left.domain.localeCompare(right.domain),
      ),
    }))
  }

  async function lift(name: string) {
    await api.liftSuspension(name)
    setOverview((current) => ({
      ...current,
      suspensions: current.suspensions.filter((other) => other.domain !== name),
    }))
  }

  async function allow(key: string) {
    const allowedKey = await api.allowKey(key)
    setOverview((current) => ({
      ...current,
      allowedKeys: current.allowedKeys.some((other) => other.pubkey === allowedKey.pubkey)
        ? current.allowedKeys
        : [...current.allowedKeys, allowedKey],
    }))
  }

  async function disallow(pubkey: string) {
    await api.disallowKey(pubkey)
    setOverview((current) => ({
      ...current,
      allowedKeys: current.allowedKeys.filter((other) => other.pubkey !== pubkey),
    }))
  }

  async function deleteReport(id: number) {
    await api.adminDeleteAbuseReport(id)
    setOverview((current) => ({
      ...current,
      abuseReports: current.abuseReports.filter((other) => other.id !== id),
    }))
  }

  async function changeSettings(changes: SettingsChanges) {
    const saved = await api.updateSettings(changes)
    setOverview((current) => ({ ...current, settings: saved }))
  }

  async function setKeyQuotas(key: string, quotas: Partial<Quotas>) {
    const saved = await api.putKeyQuotas(key, quotas)
    setOverview((current) => ({
      ...current,
      keyQuotas: [...current.keyQuotas.filter((other) => other.pubkey !== saved.pubkey), saved],
    }))
  }

  async function checkServer() {
    const { serverRecords } = await api.adminOverview()
    setOverview((current) => ({ ...current, serverRecords }))
  }

  async function removeKeyQuotas(pubkey: string) {
    await api.removeKeyQuotas(pubkey)
    setOverview((current) => ({
      ...current,
      keyQuotas: current.keyQuotas.filter((other) => other.pubkey !== pubkey),
    }))
  }

  const { domains, suspensions, allowedKeys, keyQuotas, settings, abuseReports, serverRecords } = overview
  const suspended = new Set(suspensions.map((suspension) => suspension.domain))
  const served = domains.filter((domain) => !suspended.has(domain.domain))
  const verified = served.filter((domain) => domain.verifiedAt)
  const pending = served.filter((domain) => !domain.verifiedAt)
  const sending = verified.filter((domain) => domainStatus(domain, t.admin.status).tone === 'ok').length
  const addresses = verified.reduce((total, domain) => total + domain.addressCount, 0)

  const tabs: TabLink<Tab>[] = [
    { id: 'domains', label: t.admin.tabs.domains },
    { id: 'access', label: t.admin.tabs.access, count: settings.openRegistration ? 0 : allowedKeys.length },
    { id: 'quotas', label: t.admin.tabs.quotas, count: keyQuotas.length },
    { id: 'suspended', label: t.admin.tabs.suspended, count: suspensions.length },
    { id: 'abuse', label: t.admin.tabs.abuse, count: abuseReports.length },
    { id: 'server', label: t.admin.tabs.server, count: problemsIn(serverRecords), tone: 'bad' },
    { id: 'settings', label: t.admin.tabs.settings },
  ]
  const tab = tabs.find(({ id }) => id === hash)?.id ?? opening

  const panels: Record<Tab, ReactNode> = {
    domains:
      served.length === 0 ? (
        <p className="text-sm">{t.admin.noDomain}</p>
      ) : (
        <div className="space-y-10">
          {verified.length > 0 && (
            <Section title={t.admin.connected} count={verified.length}>
              {verified.map((domain) => (
                <DomainRow key={`${domain.domain} ${domain.pubkey}`} domain={domain} onSuspend={suspend} />
              ))}
            </Section>
          )}
          {pending.length > 0 && (
            <Section title={t.admin.notVerified} count={pending.length} note={t.admin.notVerifiedNote}>
              {pending.map((domain) => (
                <DomainRow key={`${domain.domain} ${domain.pubkey}`} domain={domain} onSuspend={suspend} />
              ))}
            </Section>
          )}
        </div>
      ),
    access: (
      <AllowedKeys
        allowedKeys={allowedKeys}
        openRegistration={settings.openRegistration}
        domains={domains}
        onAllow={allow}
        onDisallow={disallow}
        onOpenRegistration={(open) => changeSettings({ openRegistration: open })}
      />
    ),
    quotas: (
      <QuotaSettings
        quotas={settings.quotas}
        keyQuotas={keyQuotas}
        onSave={(quotas) => changeSettings({ quotas })}
        onSetKey={setKeyQuotas}
        onRemoveKey={removeKeyQuotas}
      />
    ),
    suspended: (
      <>
        <p className="text-muted text-sm">{t.admin.suspendedNote}</p>
        {suspensions.length === 0 ? (
          <p className="mt-3 text-sm">{t.admin.noSuspension}</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
            {suspensions.map((suspension) => (
              <SuspendedRow
                key={suspension.domain}
                suspension={suspension}
                claims={domains.filter((domain) => domain.domain === suspension.domain)}
                onLift={lift}
              />
            ))}
          </ul>
        )}
      </>
    ),
    abuse: (
      <>
        <p className="text-muted text-sm">{t.admin.abuseNote}</p>
        {abuseReports.length === 0 ? (
          <p className="mt-3 text-sm">{t.common.noReport}</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
            {abuseReports.map((report) => (
              <AbuseReportRow
                key={report.id}
                report={report}
                load={() => api.adminAbuseMessage(report.id)}
                onDelete={() => deleteReport(report.id)}
                showDomain
              />
            ))}
          </ul>
        )}
      </>
    ),
    server: <ServerDns records={serverRecords} onCheck={checkServer} />,
    settings: <ServiceSettings settings={settings} onSave={changeSettings} />,
  }

  return (
    <>
      <h1 className="break-all font-semibold text-3xl tracking-tight">{window.location.hostname}</h1>
      <p className="mt-2 text-muted">
        {domains.length === 0 && suspensions.length === 0
          ? t.admin.noDomain
          : t.admin.summary(verified.length, sending, suspensions.length, addresses)}
      </p>
      <Tabs label={t.admin.sections} tabs={tabs} current={tab} />
      {tabs.map(({ id, label }) => (
        <section key={id} aria-label={label} hidden={id !== tab} className="mt-8">
          {panels[id]}
        </section>
      ))}
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
    <section>
      <h2 className="font-medium">
        {title} <span className="font-normal text-muted">{count}</span>
      </h2>
      {note && <p className="mt-1 text-muted text-sm">{note}</p>}
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">{children}</ul>
    </section>
  )
}

function ServerDns({ records, onCheck }: { records: ServerRecord[]; onCheck: () => Promise<void> }) {
  const t = useMessages()
  const problems = problemsIn(records)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check() {
    setBusy(true)
    setError(null)
    try {
      await onCheck()
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className={`text-sm ${problems ? 'text-bad' : 'text-ok'}`}>
        {problems ? t.admin.toFix(problems) : t.admin.allFound}
      </p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {records.map((record) => (
          <RecordRow key={record.id} record={record} hint={t.admin.serverHints[record.id]} />
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button variant={problems ? 'primary' : 'secondary'} onClick={check} disabled={busy}>
          {busy ? t.domainPage.checking : t.domainPage.check}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </>
  )
}

function problemsIn(records: ServerRecord[]): number {
  return records.filter((record) => record.check.status !== 'ok').length
}

function DomainRow({ domain, onSuspend }: { domain: AdminDomain; onSuspend: (name: string) => Promise<void> }) {
  const t = useMessages()
  const locale = useLocale()
  const status = domainStatus(domain, t.admin.status)

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="break-all font-medium">{domain.domain}</p>
        <p className={`text-sm ${TONES[status.tone]}`}>{status.text}</p>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted text-sm">
        <Owner domain={domain} />
        {domain.verifiedAt && <span>{t.admin.namedAddresses(domain.addressCount)}</span>}
        {domain.shared && <span>{t.admin.openToEveryone}</span>}
        <span>{t.admin.claimed(timeAgo(domain.createdAt, locale))}</span>
        {domain.checkedAt && <span>{t.common.checked(timeAgo(domain.checkedAt, locale))}</span>}
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
  const t = useMessages()
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function lift() {
    setBusy(true)
    setError(null)
    try {
      await onLift(suspension.domain)
    } catch (failure) {
      setError(describeError(failure, t.errors))
      setBusy(false)
    }
  }

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="break-all font-medium">{suspension.domain}</p>
        <p className="text-bad text-sm">{t.admin.suspendedSince(timeAgo(suspension.suspendedAt, locale))}</p>
      </div>
      {claims.length === 0 && <p className="mt-1 text-muted text-sm">{t.admin.noClaim}</p>}
      {claims.map((claim) => (
        <div key={claim.pubkey} className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted text-sm">
          <Owner domain={claim} />
          <span>{claim.verifiedAt ? t.admin.verifiedWith(claim.addressCount) : t.admin.unverified}</span>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <Button variant="quiet" onClick={lift} disabled={busy}>
          {busy ? t.admin.lifting : t.admin.lift}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </li>
  )
}

function SuspendAction({ name, onSuspend }: { name: string; onSuspend: (name: string) => Promise<void> }) {
  const t = useMessages()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function suspend() {
    setBusy(true)
    setError(null)
    try {
      await onSuspend(name)
    } catch (failure) {
      setError(describeError(failure, t.errors))
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {confirming ? (
        <>
          <span>{t.admin.suspendConfirm(name)}</span>
          <Button variant="quiet" className="text-bad" onClick={suspend} disabled={busy}>
            {busy ? t.admin.suspending : t.admin.suspend}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
            {t.common.cancel}
          </Button>
        </>
      ) : (
        <Button variant="quiet" onClick={() => setConfirming(true)}>
          {t.admin.suspendDomain}
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function Owner({ domain }: { domain: AdminDomain }) {
  const t = useMessages().admin
  const npub = npubOf(domain.pubkey)
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono">{shortNpub(npub)}</span>
      <CopyButton text={npub} label={t.ownerNpub(domain.domain)} />
    </span>
  )
}

function Records({ checks }: { checks: Record<RecordId, RecordCheck> }) {
  const t = useMessages().admin
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t.lastCheck}>
      {RECORDS.map((id) => {
        const check = recordStatus(id, checks[id].status)
        const text = t.checks[checks[id].status]
        const found = checks[id].found.join(', ')
        return (
          <li key={id} className={TONES[check.tone]} title={found ? `${text}: ${found}` : text}>
            <span aria-hidden="true">{check.glyph}</span> {t.recordNames[id]}
            <span className="sr-only">, {text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function domainStatus(domain: AdminDomain, messages: Messages['admin']['status']): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.checks?.[id].status === 'ok'
  if (!domain.verifiedAt) {
    return { tone: 'wait', text: domain.checkedAt ? messages.ownershipNotFound : messages.neverChecked }
  }
  if (!found('mx')) return { tone: 'wait', text: messages.noMx }
  if (!found('nip05') || !found('spf') || !found('dkim')) return { tone: 'wait', text: messages.receivingOnly }
  return { tone: 'ok', text: messages.ok }
}

const CHECKS: Record<CheckStatus, { tone: Tone; glyph: string }> = {
  ok: { tone: 'ok', glyph: '✓' },
  missing: { tone: 'wait', glyph: '○' },
  mismatch: { tone: 'bad', glyph: '✗' },
  error: { tone: 'bad', glyph: '✗' },
}

// DMARC is recommended, not required.
function recordStatus(id: RecordId, status: CheckStatus) {
  const check = CHECKS[status]
  return id === 'dmarc' && status !== 'ok' ? { ...check, tone: 'none' as const } : check
}
