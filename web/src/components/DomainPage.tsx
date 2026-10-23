import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { type Api, ApiError, createApi, type DnsRecord, type Domain, type RecordId } from '../lib/api'
import { domainStatus } from '../lib/domain'
import { describeError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import AbuseReportRow from './AbuseReportRow'
import Addresses from './Addresses'
import DomainKey from './DomainKey'
import RecordRow from './RecordRow'
import { type TabLink, Tabs, useHash } from './Tabs'
import { BackLink, Button, ErrorText, TONES } from './ui'

type Tab = 'addresses' | 'dns' | 'abuse' | 'settings'

const TABS: Record<Tab, { label: string; shown: (domain: Domain) => boolean }> = {
  addresses: { label: 'Addresses', shown: (domain) => domain.verifiedAt !== null && domain.suspendedAt === null },
  dns: { label: 'DNS', shown: (domain) => domain.suspendedAt === null },
  abuse: { label: 'Abuse reports', shown: (domain) => domain.verifiedAt !== null },
  settings: { label: 'Settings', shown: () => true },
}

const RECEIVE: RecordId[] = ['ownership', 'mx', 'https']
const SEND: RecordId[] = ['spf', 'dkim', 'dmarc']

export default function DomainPage({ signer }: { signer: Signer }) {
  const api = useMemo(() => createApi(signer), [signer])
  const [name] = useState(() => new URLSearchParams(window.location.search).get('name') ?? '')
  const [domain, setDomain] = useState<Domain | null>(null)
  const [missing, setMissing] = useState(!name)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!name) return
    api.getDomain(name).then(setDomain, (failure) => {
      if (failure instanceof ApiError && failure.code === 'domain_not_found') setMissing(true)
      else setError(describeError(failure))
    })
  }, [api, name])

  return (
    <div className="pt-10 sm:pt-16">
      <BackLink href="/dashboard">Your domains</BackLink>
      {missing && <p className="mt-6">This domain is not connected to your key.</p>}
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
  const [domain, setDomain] = useState(initial)
  // Picked once, so that a check of the DNS does not switch tabs under the user.
  const [opening] = useState(() => openingTab(initial))
  const hash = useHash()
  const tabs: TabLink<Tab>[] = (Object.keys(TABS) as Tab[])
    .filter((id) => TABS[id].shown(domain))
    .map((id) => ({ id, label: TABS[id].label, count: id === 'abuse' ? domain.abuseReports.length : undefined }))
  const tab = tabs.find(({ id }) => id === hash)?.id ?? opening
  const status = domainStatus(domain)

  useEffect(() => {
    document.title = `${domain.domain} on Nostr Mail`
  }, [domain.domain])

  async function deleteReport(id: number) {
    await api.deleteAbuseReport(domain.domain, id)
    setDomain((current) => ({
      ...current,
      abuseReports: current.abuseReports.filter((other) => other.id !== id),
    }))
  }

  const panels: Record<Tab, ReactNode> = {
    addresses: <Addresses domain={domain.domain} api={api} ownPubkey={ownPubkey} />,
    dns: <DnsPanel domain={domain} api={api} onChange={setDomain} />,
    abuse: <AbusePanel domain={domain} api={api} onDelete={deleteReport} />,
    settings: <SettingsPanel domain={domain} api={api} onChange={setDomain} />,
  }

  return (
    <>
      <h1 className="mt-3 break-all font-semibold text-3xl tracking-tight">{domain.domain}</h1>
      <p className="mt-1 text-sm">
        <span className={TONES[status.tone]}>{status.text}</span>
        {domain.checkedAt && <span className="text-muted">, checked {timeAgo(domain.checkedAt)}</span>}
      </p>

      {domain.suspendedAt && (
        <p className="mt-6 max-w-xl text-sm">
          The domain no longer receives nor sends mail, and its addresses no longer resolve. Mail sent to abuse@
          {domain.domain} still reaches you and the admins of this server. Ask them why the domain is suspended.
        </p>
      )}

      <Tabs label={`Sections of ${domain.domain}`} tabs={tabs} current={tab} />
      {tabs.map(({ id, label }) => (
        <section key={id} aria-label={label} hidden={id !== tab} className="mt-8">
          {panels[id]}
        </section>
      ))}
    </>
  )
}

function DnsPanel({ domain, api, onChange }: { domain: Domain; api: Api; onChange: (domain: Domain) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = domainStatus(domain).tone === 'ok'

  async function check() {
    setBusy(true)
    setError(null)
    try {
      onChange(await api.checkDomain(domain.domain))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <RecordGroup
        title="To receive mail"
        note="The MX record sends all mail for the domain here, the A record lets apps find its addresses. Some DNS providers want only the part of the name before your domain, like _nostr-mail, and nothing for the domain itself."
        records={pick(domain, RECEIVE)}
      />
      <RecordGroup
        title="To send mail"
        note="SPF and DKIM prove that mail from the domain really comes from it. If the domain already has an SPF record, add the include to it rather than publishing a second one."
        records={pick(domain, SEND)}
      />
      <div className="flex flex-wrap items-center gap-4">
        <Button variant={done ? 'secondary' : 'primary'} onClick={check} disabled={busy}>
          {busy ? 'Checking' : 'Check DNS'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  )
}

function AbusePanel({ domain, api, onDelete }: { domain: Domain; api: Api; onDelete: (id: number) => Promise<void> }) {
  return (
    <>
      <p className="text-muted text-sm">
        Mail sent to abuse@{domain.domain}, newest first. The admins of this server get it too, and keep the reports you
        delete.
      </p>
      {domain.abuseReports.length === 0 ? (
        <p className="mt-3 text-sm">No report yet.</p>
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
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await api.removeDomain(domain.domain)
      window.location.assign('/dashboard')
    } catch (failure) {
      setError(describeError(failure))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* Keyed by the key, so that a revealed nsec goes with the key it belongs to. */}
      <DomainKey key={domain.bridgePubkey} domain={domain} api={api} onChange={onChange} />
      <div>
        <h2 className="font-medium">Remove the domain</h2>
        <p className="mt-1 max-w-xl text-muted text-sm">
          {domain.domain} stops receiving and sending mail
          {domain.verifiedAt ? ', but mail to abuse@ still reaches the admins of this server.' : '.'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          {confirming ? (
            <>
              <span>Remove {domain.domain}?</span>
              <Button variant="quiet" className="text-bad" onClick={remove} disabled={busy}>
                {busy ? 'Removing' : 'Remove'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Remove domain
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

function openingTab(domain: Domain): Tab {
  if (domain.suspendedAt) return domain.verifiedAt ? 'abuse' : 'settings'
  return domainStatus(domain).tone === 'ok' ? 'addresses' : 'dns'
}
