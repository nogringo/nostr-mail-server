import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { localize, useLocale, useMessages } from '../i18n'
import type { Messages } from '../i18n/en'
import { type Api, ApiError, createApi, type DnsRecord, type Domain, type RecordId } from '../lib/api'
import { domainStatus } from '../lib/domain'
import { describeError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import AbuseReportRow from './AbuseReportRow'
import Addresses from './Addresses'
import DomainKey from './DomainKey'
import Nip05Group from './Nip05Group'
import RecordRow from './RecordRow'
import { type TabLink, Tabs, useHash } from './Tabs'
import { BackLink, Button, ErrorText, TONES } from './ui'

type Tab = 'addresses' | 'dns' | 'abuse' | 'settings'

const TABS: Record<Tab, (domain: Domain) => boolean> = {
  addresses: (domain) => domain.verifiedAt !== null && domain.suspendedAt === null,
  dns: (domain) => domain.suspendedAt === null,
  abuse: (domain) => domain.verifiedAt !== null,
  settings: () => true,
}

const RECEIVE: RecordId[] = ['ownership', 'mx']
const SEND: RecordId[] = ['spf', 'dkim', 'dmarc']

export default function DomainPage({ signer }: { signer: Signer }) {
  const t = useMessages()
  const locale = useLocale()
  const api = useMemo(() => createApi(signer), [signer])
  const [name] = useState(() => new URLSearchParams(window.location.search).get('name') ?? '')
  const [domain, setDomain] = useState<Domain | null>(null)
  const [missing, setMissing] = useState(!name)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!name) return
    api.getDomain(name).then(setDomain, (failure) => {
      if (failure instanceof ApiError && failure.code === 'domain_not_found') setMissing(true)
      else setError(describeError(failure, t.errors))
    })
  }, [api, name, t])

  return (
    <div className="pt-10 sm:pt-16">
      <BackLink href={localize('/dashboard', locale)}>{t.common.yourDomains}</BackLink>
      {missing && <p className="mt-6">{t.domainPage.missing}</p>}
      {error && (
        <div className="mt-6">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {domain && <DomainView initial={domain} api={api} ownPubkey={signer.pubkey} />}
    </div>
  )
}

function DomainView({ initial, api, ownPubkey }: { initial: Domain; api: Api; ownPubkey: string }) {
  const t = useMessages()
  const locale = useLocale()
  const [domain, setDomain] = useState(initial)
  // Picked once, so that a check of the DNS does not switch tabs under the user.
  const [opening] = useState(() => openingTab(initial, t.domainStatus))
  const hash = useHash()
  const tabs: TabLink<Tab>[] = (Object.keys(TABS) as Tab[])
    .filter((id) => TABS[id](domain))
    .map((id) => ({
      id,
      label: t.domainPage.tabs[id],
      count: id === 'abuse' ? domain.abuseReports.length : undefined,
    }))
  const tab = tabs.find(({ id }) => id === hash)?.id ?? opening
  const status = domainStatus(domain, t.domainStatus)

  useEffect(() => {
    document.title = t.domainPage.documentTitle(domain.domain)
  }, [domain.domain, t])

  async function deleteReport(id: number) {
    await api.deleteAbuseReport(domain.domain, id)
    setDomain((current) => ({
      ...current,
      abuseReports: current.abuseReports.filter((other) => other.id !== id),
    }))
  }

  const panels: Record<Tab, ReactNode> = {
    addresses: (
      <div className="space-y-10">
        <Addresses domain={domain.domain} api={api} ownPubkey={ownPubkey} />
        <DomainSwitch
          title={t.domainPage.catchAll.title}
          label={t.domainPage.catchAll.label(domain.domain)}
          note={t.domainPage.catchAll.note}
          checked={domain.catchAll}
          blockedBy={domain.shared ? t.domainPage.catchAll.blocked : null}
          toggle={(catchAll) => api.setCatchAll(domain.domain, catchAll)}
          onChange={setDomain}
        />
        <DomainSwitch
          title={t.domainPage.shared.title}
          label={t.domainPage.shared.label(domain.domain)}
          note={t.domainPage.shared.note}
          checked={domain.shared}
          blockedBy={domain.catchAll ? t.domainPage.shared.blocked : null}
          toggle={(shared) => api.setShared(domain.domain, shared)}
          onChange={setDomain}
        />
      </div>
    ),
    dns: <DnsPanel domain={domain} api={api} onChange={setDomain} />,
    abuse: <AbusePanel domain={domain} api={api} onDelete={deleteReport} />,
    settings: <SettingsPanel domain={domain} api={api} onChange={setDomain} />,
  }

  return (
    <>
      <h1 className="mt-3 break-all font-semibold text-3xl tracking-tight">{domain.domain}</h1>
      <p className="mt-1 text-sm">
        <span className={TONES[status.tone]}>{status.text}</span>
        {domain.checkedAt && (
          <span className="text-muted">, {t.common.checked(timeAgo(domain.checkedAt, locale))}</span>
        )}
      </p>

      {domain.suspendedAt && <p className="mt-6 max-w-xl text-sm">{t.domainPage.suspended(domain.domain)}</p>}

      <Tabs label={t.domainPage.sections(domain.domain)} tabs={tabs} current={tab} />
      {tabs.map(({ id, label }) => (
        <section key={id} aria-label={label} hidden={id !== tab} className="mt-8">
          {panels[id]}
        </section>
      ))}
    </>
  )
}

function DnsPanel({ domain, api, onChange }: { domain: Domain; api: Api; onChange: (domain: Domain) => void }) {
  const t = useMessages()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = domainStatus(domain, t.domainStatus).tone === 'ok'

  async function check() {
    setBusy(true)
    setError(null)
    try {
      onChange(await api.checkDomain(domain.domain))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <RecordGroup
        title={t.domainPage.receive.title}
        note={t.domainPage.receive.note}
        records={pick(domain, RECEIVE)}
      />
      <Nip05Group domain={domain} api={api} onChange={onChange} />
      <RecordGroup title={t.domainPage.send.title} note={t.domainPage.send.note} records={pick(domain, SEND)} />
      <div className="flex flex-wrap items-center gap-4">
        <Button variant={done ? 'secondary' : 'primary'} onClick={check} disabled={busy}>
          {busy ? t.domainPage.checking : t.domainPage.check}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  )
}

// A domain is shared or catch-all, never both: the switch of the other is blocked meanwhile.
function DomainSwitch({
  title,
  label,
  note,
  checked,
  blockedBy,
  toggle,
  onChange,
}: {
  title: string
  label: string
  note: string
  checked: boolean
  blockedBy: string | null
  toggle: (checked: boolean) => Promise<Domain>
  onChange: (domain: Domain) => void
}) {
  const t = useMessages()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function change(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      onChange(await toggle(next))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 className="font-medium">{title}</h2>
      <label className="mt-3 flex w-fit cursor-pointer items-start gap-2 text-sm has-disabled:cursor-default">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy || blockedBy !== null}
          onChange={(event) => change(event.target.checked)}
          className="mt-1 accent-accent"
        />
        <span>
          {label}
          <span className="block max-w-xl text-muted">
            {note}
            {blockedBy && ` ${blockedBy}`}
          </span>
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function AbusePanel({ domain, api, onDelete }: { domain: Domain; api: Api; onDelete: (id: number) => Promise<void> }) {
  const t = useMessages()

  return (
    <>
      <p className="text-muted text-sm">{t.domainPage.abuse(domain.domain)}</p>
      {domain.abuseReports.length === 0 ? (
        <p className="mt-3 text-sm">{t.common.noReport}</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {domain.abuseReports.map((report) => (
            <AbuseReportRow
              key={report.id}
              report={report}
              load={() => api.abuseMessage(domain.domain, report.id)}
              onDelete={() => onDelete(report.id)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function SettingsPanel({ domain, api, onChange }: { domain: Domain; api: Api; onChange: (domain: Domain) => void }) {
  const t = useMessages()
  const locale = useLocale()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await api.removeDomain(domain.domain)
      window.location.assign(localize('/dashboard', locale))
    } catch (failure) {
      setError(describeError(failure, t.errors))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* Keyed by the key, so that a revealed nsec goes with the key it belongs to. */}
      <DomainKey key={domain.bridgePubkey} domain={domain} api={api} onChange={onChange} />
      <div>
        <h2 className="font-medium">{t.domainPage.remove.title}</h2>
        <p className="mt-1 max-w-xl text-muted text-sm">
          {t.domainPage.remove.effect(domain.domain, domain.verifiedAt !== null)}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          {confirming ? (
            <>
              <span>{t.domainPage.remove.confirm(domain.domain)}</span>
              <Button variant="quiet" className="text-bad" onClick={remove} disabled={busy}>
                {busy ? t.common.removing : t.common.remove}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                {t.common.cancel}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              {t.domainPage.remove.button}
            </Button>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </div>
  )
}

function RecordGroup({ title, note, records }: { title: string; note: string; records: DnsRecord[] }) {
  return (
    <div>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-muted text-sm">{note}</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {records.map((record) => (
          <RecordRow key={record.id} record={record} />
        ))}
      </ul>
    </div>
  )
}

function pick(domain: Domain, ids: RecordId[]): DnsRecord[] {
  return domain.records.filter((record) => ids.includes(record.id))
}

function openingTab(domain: Domain, messages: Messages['domainStatus']): Tab {
  if (domain.suspendedAt) return domain.verifiedAt ? 'abuse' : 'settings'
  return domainStatus(domain, messages).tone === 'ok' ? 'addresses' : 'dns'
}
