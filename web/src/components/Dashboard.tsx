import { useEffect, useMemo, useState } from 'react'
import { createApi, type Domain, type DomainList } from '../lib/api'
import { domainHref, domainStatus } from '../lib/domain'
import { describeError } from '../lib/errors'
import { plural, timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import PrivateServer from './PrivateServer'
import SharedAddresses from './SharedAddresses'
import { ButtonLink, ErrorText, TONES } from './ui'

export default function Dashboard({ signer }: { signer: Signer }) {
  const api = useMemo(() => createApi(signer), [signer])
  const [list, setList] = useState<DomainList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listDomains().then(setList, (failure) => setError(describeError(failure)))
  }, [api])

  const domains = list?.domains

  return (
    <div className="pt-10 sm:pt-16">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-semibold text-3xl tracking-tight">Your domains</h1>
        {list?.canClaim && <ButtonLink href="/connect">Connect a domain</ButtonLink>}
      </div>
      {error && (
        <div className="mt-6">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {list && !list.canClaim && (
        <div className="mt-6">
          <PrivateServer pubkey={signer.pubkey} />
        </div>
      )}
      {list?.canClaim && domains?.length === 0 && (
        <p className="mt-6 max-w-xl text-muted">
          No domain yet. Connect one you own to receive its mail in Nostr Mail.
        </p>
      )}
      {domains && domains.length > 0 && (
        <ul className="mt-8 divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface">
          {domains.map((domain) => (
            <DomainRow key={domain.domain} domain={domain} />
          ))}
        </ul>
      )}
      {list && (list.sharedDomains.length > 0 || list.addresses.length > 0) && (
        <SharedAddresses api={api} domains={list.sharedDomains} initial={list.addresses} />
      )}
    </div>
  )
}

function DomainRow({ domain }: { domain: Domain }) {
  const status = domainStatus(domain)
  const reports = domain.abuseReports.length

  return (
    <li>
      <a href={domainHref(domain.domain)} className="block px-4 py-4 hover:bg-paper">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="break-all font-medium">{domain.domain}</p>
          <p className={`text-sm ${TONES[status.tone]}`}>{status.text}</p>
        </div>
        {(domain.checkedAt || reports > 0) && (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted text-sm">
            {domain.checkedAt && <span>checked {timeAgo(domain.checkedAt)}</span>}
            {reports > 0 && <span>{plural(reports, 'abuse report')}</span>}
          </div>
        )}
      </a>
    </li>
  )
}
