import { useEffect, useMemo, useState } from 'react'
import { localize, useLocale, useMessages } from '../i18n'
import { createApi, type Domain, type DomainList, QUOTA_NAMES, type Quotas, type QuotaUsage } from '../lib/api'
import { domainHref, domainStatus } from '../lib/domain'
import { describeError } from '../lib/errors'
import { timeAgo } from '../lib/format'
import type { Signer } from '../lib/signer'
import PrivateServer from './PrivateServer'
import SharedAddresses from './SharedAddresses'
import { ButtonLink, ErrorText, TONES } from './ui'

export default function Dashboard({ signer }: { signer: Signer }) {
  const t = useMessages()
  const locale = useLocale()
  const api = useMemo(() => createApi(signer), [signer])
  const [list, setList] = useState<DomainList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listDomains().then(setList, (failure) => setError(describeError(failure, t.errors)))
  }, [api, t])

  const domains = list?.domains

  function countAddresses(change: number) {
    setList((current) => current && { ...current, usage: { addresses: current.usage.addresses + change } })
  }

  return (
    <div className="pt-10 sm:pt-16">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-semibold text-3xl tracking-tight">{t.common.yourDomains}</h1>
        {list?.canClaim && <ButtonLink href={localize('/connect', locale)}>{t.dashboard.connect}</ButtonLink>}
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
      {list?.canClaim && domains?.length === 0 && <p className="mt-6 max-w-xl text-muted">{t.dashboard.empty}</p>}
      {domains && domains.length > 0 && (
        <ul className="mt-8 divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface">
          {domains.map((domain) => (
            <DomainRow key={domain.domain} domain={domain} />
          ))}
        </ul>
      )}
      {list && (list.sharedDomains.length > 0 || list.addresses.length > 0) && (
        <SharedAddresses
          api={api}
          domains={list.sharedDomains}
          initial={list.addresses}
          onCountChange={countAddresses}
        />
      )}
      {list && <QuotaList quotas={list.quotas} usage={list.usage} />}
    </div>
  )
}

// Only the quotas with a limit.
function QuotaList({ quotas, usage }: { quotas: Quotas; usage: QuotaUsage }) {
  const t = useMessages().dashboard.quotas
  const lines = QUOTA_NAMES.flatMap((name) => {
    const limit = quotas[name]
    if (limit === null) return []
    return [name === 'addresses' ? t.addresses(usage.addresses, limit) : t[name](limit)]
  })
  if (!lines.length) return null

  return (
    <section aria-labelledby="quotas" className="mt-14">
      <h2 id="quotas" className="font-semibold text-xl tracking-tight">
        {t.title}
      </h2>
      <ul className="mt-3 space-y-1 text-sm">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-muted text-sm">{t.more}</p>
    </section>
  )
}

function DomainRow({ domain }: { domain: Domain }) {
  const t = useMessages()
  const locale = useLocale()
  const status = domainStatus(domain, t.domainStatus)
  const reports = domain.abuseReports.length

  return (
    <li>
      <a href={domainHref(domain.domain, locale)} className="block px-4 py-4 hover:bg-paper">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="break-all font-medium">{domain.domain}</p>
          <p className={`text-sm ${TONES[status.tone]}`}>{status.text}</p>
        </div>
        {(domain.checkedAt || reports > 0) && (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted text-sm">
            {domain.checkedAt && <span>{t.common.checked(timeAgo(domain.checkedAt, locale))}</span>}
            {reports > 0 && <span>{t.dashboard.abuseReports(reports)}</span>}
          </div>
        )}
      </a>
    </li>
  )
}
