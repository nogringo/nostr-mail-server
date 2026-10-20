import { useState } from 'react'
import type { Api, CheckStatus, DnsRecord, Domain, RecordId } from '../lib/api'
import { describeError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import Addresses from './Addresses'
import { Button, CopyButton, ErrorText } from './ui'

const RECEIVE: RecordId[] = ['ownership', 'mx', 'https']
const SEND: RecordId[] = ['spf', 'dkim', 'dmarc']

const TONES = { ok: 'text-ok', wait: 'text-wait', bad: 'text-bad', none: 'text-muted' }

interface Props {
  domain: Domain
  ownPubkey: string
  api: Api
  onChange: (domain: Domain) => void
  onRemove: (name: string) => void
}

// A domain that does not send and receive yet shows its DNS setup. Once it
// does, its addresses come first and the records stay one click away.
export default function DomainSection({ domain, ownPubkey, api, onChange, onRemove }: Props) {
  const [busy, setBusy] = useState<'check' | 'remove' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [dnsShown, setDnsShown] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const status = domainStatus(domain)
  const needsDns = status.tone !== 'ok'

  async function run(action: 'check' | 'remove', setError: (error: string | null) => void, task: () => Promise<void>) {
    setBusy(action)
    setError(null)
    try {
      await task()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(null)
    }
  }

  const check = () => run('check', setCheckError, async () => onChange(await api.checkDomain(domain.domain)))
  const remove = () =>
    run('remove', setRemoveError, async () => {
      await api.removeDomain(domain.domain)
      onRemove(domain.domain)
    })

  // What needs fixing comes before the addresses.
  const dns = (
    <div id={`dns-${domain.domain}`} className="mt-8">
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
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button variant={needsDns ? 'primary' : 'secondary'} onClick={check} disabled={busy !== null}>
          {busy === 'check' ? 'Checking' : 'Check DNS'}
        </Button>
        <ErrorText>{checkError}</ErrorText>
      </div>
    </div>
  )

  return (
    <section className="border-rule border-t py-10" aria-labelledby={`domain-${domain.domain}`}>
      <h2 id={`domain-${domain.domain}`} className="font-semibold text-2xl tracking-tight">
        {domain.domain}
      </h2>
      <p className="mt-1 text-sm">
        <span className={TONES[status.tone]}>{status.text}</span>
        {domain.checkedAt && <span className="text-muted">, checked {timeAgo(domain.checkedAt)}</span>}
      </p>

      {needsDns && dns}
      {domain.verifiedAt && <Addresses domain={domain.domain} api={api} ownPubkey={ownPubkey} />}
      {!needsDns && dnsShown && dns}

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {!needsDns && (
          <Button
            variant="quiet"
            aria-expanded={dnsShown}
            aria-controls={`dns-${domain.domain}`}
            onClick={() => setDnsShown((shown) => !shown)}
          >
            {dnsShown ? 'Hide DNS records' : 'Show DNS records'}
          </Button>
        )}
        {confirming ? (
          <span className="flex flex-wrap items-center gap-4">
            <span>Remove {domain.domain}? It will stop receiving and sending mail.</span>
            <Button variant="quiet" className="text-bad" onClick={remove} disabled={busy !== null}>
              {busy === 'remove' ? 'Removing' : 'Remove'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            Remove domain
          </Button>
        )}
        <ErrorText>{removeError}</ErrorText>
      </div>
    </section>
  )
}

function RecordGroup({ title, note, records }: { title: string; note: string; records: DnsRecord[] }) {
  return (
    <div className="mt-8">
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 text-muted text-sm">{note}</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {records.map((record) => (
          <RecordRow key={record.id} record={record} />
        ))}
      </ul>
    </div>
  )
}

function RecordRow({ record }: { record: DnsRecord }) {
  const check = recordStatus(record)
  const failed = record.check && record.check.status !== 'ok' && record.check.found.length > 0

  return (
    <li className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3rem_minmax(0,1fr)_9rem]">
      <span className="font-medium font-mono text-muted text-sm leading-6">{record.type}</span>
      <div className="min-w-0 space-y-1 font-mono text-sm leading-6">
        <Field text={record.name} label={`${record.type} name`} />
        <Field text={record.value} label={`${record.type} value`} />
        {record.priority !== undefined && <p className="font-sans text-muted">Priority {record.priority}</p>}
        {failed && (
          <p className="break-all font-sans text-bad">
            Found: <span className="font-mono">{record.check?.found.join(', ')}</span>
          </p>
        )}
      </div>
      <p className={`col-start-2 text-sm leading-6 sm:col-start-3 sm:text-right ${TONES[check.tone]}`}>{check.text}</p>
    </li>
  )
}

function Field({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="break-all">{text}</span>
      <CopyButton text={text} label={label} />
    </div>
  )
}

function pick(domain: Domain, ids: RecordId[]): DnsRecord[] {
  return domain.records.filter((record) => ids.includes(record.id))
}

type Tone = keyof typeof TONES

function domainStatus(domain: Domain): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.records.find((record) => record.id === id)?.check?.status === 'ok'
  if (!domain.checkedAt) return { tone: 'wait', text: 'Publish the records below, then check DNS' }
  if (!domain.verifiedAt) return { tone: 'wait', text: 'Waiting for the ownership record' }
  if (!found('mx')) return { tone: 'wait', text: 'Verified, waiting for the MX record' }
  if (!found('https')) return { tone: 'wait', text: 'Receiving mail, waiting for the A record' }
  if (!found('spf') || !found('dkim')) return { tone: 'wait', text: 'Receiving mail, waiting for SPF and DKIM to send' }
  return { tone: 'ok', text: 'Sending and receiving mail' }
}

const CHECKS: Record<CheckStatus, { tone: Tone; text: string }> = {
  ok: { tone: 'ok', text: 'Found' },
  missing: { tone: 'wait', text: 'Missing' },
  mismatch: { tone: 'bad', text: 'Different value' },
  error: { tone: 'bad', text: 'Lookup failed' },
}

function recordStatus(record: DnsRecord): { tone: Tone; text: string } {
  if (!record.check) return { tone: 'none', text: 'Not checked' }
  if (!record.required && record.check.status !== 'ok') return { tone: 'none', text: 'Optional' }
  return CHECKS[record.check.status]
}
