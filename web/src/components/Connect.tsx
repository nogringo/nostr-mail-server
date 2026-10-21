import { type SubmitEvent, useMemo, useState } from 'react'
import { ApiError, createApi } from '../lib/api'
import { domainHref } from '../lib/domain'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub } from '../lib/format'
import type { Signer } from '../lib/signer'
import PrivateServer from './PrivateServer'
import { BackLink, Button, ErrorText } from './ui'

// The address the domain will receive, written as the user types the domain.
export default function Connect({ signer }: { signer: Signer }) {
  const api = useMemo(() => createApi(signer), [signer])
  const npub = npubOf(signer.pubkey)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = name.trim().toLowerCase()
    if (!value) return

    setBusy(true)
    setError(null)
    try {
      const domain = await api.connectDomain(value)
      window.location.assign(domainHref(domain.domain))
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'not_allowed') setRefused(true)
      else setError(describeError(failure))
      setBusy(false)
    }
  }

  if (refused) {
    return (
      <div className="pt-10 sm:pt-16">
        <BackLink href="/dashboard">Your domains</BackLink>
        <h1 className="mt-3 font-semibold text-3xl tracking-tight">Connect a domain</h1>
        <div className="mt-6">
          <PrivateServer pubkey={signer.pubkey} />
        </div>
      </div>
    )
  }

  return (
    <div className="pt-10 sm:pt-16">
      <BackLink href="/dashboard">Your domains</BackLink>
      <form onSubmit={submit}>
        <h1 className="mt-3 font-semibold text-3xl tracking-tight">Connect a domain</h1>
        <p className="mt-2 max-w-xl text-muted">
          Type a domain you own. Mail sent to this address will reach you in Nostr Mail once its DNS records are
          published.
        </p>

        <div className="mt-8 flex flex-wrap items-baseline font-semibold text-[clamp(1.6rem,5vw,3rem)] leading-tight tracking-tight">
          <span className="text-muted" title={npub}>
            {shortNpub(npub)}
          </span>
          <span className="text-accent">@</span>
          <label htmlFor="domain" className="sr-only">
            Domain
          </label>
          <input
            id="domain"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="yourdomain.com"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 basis-56 border-rule border-b-2 bg-transparent pb-1 caret-accent placeholder:text-rule focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Connecting' : 'Connect domain'}
          </Button>
          <ErrorText>{error}</ErrorText>
        </div>
      </form>
    </div>
  )
}
