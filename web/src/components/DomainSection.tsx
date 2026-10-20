import { useState } from 'react'
import type { Api, DnsRecord, Domain, RecordId } from '../lib/api'
import { describeError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import AbuseReportRow from './AbuseReportRow'
import Addresses from './Addresses'
import RecordRow from './RecordRow'
import { Button, ErrorText, TONES, type Tone } from './ui'

const RECEIVE: RecordId[] = ['ownership', 'mx', 'https']
const SEND: RecordId[] = ['spf', 'dkim', 'dmarc']

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
  const suspended = domain.suspendedAt !== null
  const needsDns = !suspended && status.tone !== 'ok'

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

      {suspended && (
        <p className="mt-6 max-w-xl text-sm">
          The domain no longer receives nor sends mail, and its addresses no longer resolve. Mail sent to abuse@
          {domain.domain} still reaches you and the admins of this server. Ask them why the domain is suspended.
        </p>
      )}
      {needsDns && dns}
      {domain.verifiedAt && !suspended && <Addresses domain={domain.domain} api={api} ownPubkey={ownPubkey} />}
      {domain.abuseReports.length > 0 && (
        <div className="mt-8">
          <h3 className="font-medium">
            Abuse reports <span className="font-normal text-muted">{domain.abuseReports.length}</span>
          </h3>
          <p className="mt-1 text-muted text-sm">
            Mail sent to abuse@{domain.domain}, newest first. The admins of this server get it too.
          </p>
          <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
            {domain.abuseReports.map((report) => (
              <AbuseReportRow key={report.id} report={report} load={() => api.abuseMessage(domain.domain, report.id)} />
            ))}
          </ul>
        </div>
      )}
      {!needsDns && !suspended && dnsShown && dns}

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {!needsDns && !suspended && (
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
            <span>
              Remove {domain.domain}? It will stop receiving and sending mail
              {domain.verifiedAt ? ', but mail to abuse@ still reaches the admins of this server.' : '.'}
            </span>
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

function pick(domain: Domain, ids: RecordId[]): DnsRecord[] {
  return domain.records.filter((record) => ids.includes(record.id))
}

function domainStatus(domain: Domain): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.records.find((record) => record.id === id)?.check?.status === 'ok'
  if (domain.suspendedAt) return { tone: 'bad', text: 'Suspended by the admin of this server' }
  if (!domain.checkedAt) return { tone: 'wait', text: 'Publish the records below, then check DNS' }
  if (!domain.verifiedAt) return { tone: 'wait', text: 'Waiting for the ownership record' }
  if (!found('mx')) return { tone: 'wait', text: 'Verified, waiting for the MX record' }
  if (!found('https')) return { tone: 'wait', text: 'Receiving mail, waiting for the A record' }
  if (!found('spf') || !found('dkim')) return { tone: 'wait', text: 'Receiving mail, waiting for SPF and DKIM to send' }
  return { tone: 'ok', text: 'Sending and receiving mail' }
}
