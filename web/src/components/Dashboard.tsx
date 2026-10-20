import { type SubmitEvent, useEffect, useMemo, useState } from 'react'
import { createApi, type Domain } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub } from '../lib/format'
import type { Signer } from '../lib/signer'
import DomainSection from './DomainSection'
import { Button, ErrorText } from './ui'

export default function Dashboard({ signer }: { signer: Signer }) {
  const api = useMemo(() => createApi(signer), [signer])
  const npub = npubOf(signer.pubkey)
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    api.listDomains().then(setDomains, (error) => setLoadError(describeError(error)))
  }, [api])

  async function connect(name: string) {
    const domain = await api.connectDomain(name)
    setDomains((list) => [domain, ...(list ?? []).filter((other) => other.domain !== domain.domain)])
  }

  function replace(domain: Domain) {
    setDomains((list) => (list ?? []).map((other) => (other.domain === domain.domain ? domain : other)))
  }

  function remove(name: string) {
    setDomains((list) => (list ?? []).filter((other) => other.domain !== name))
  }

  return (
    <>
      <Composer npub={npub} onConnect={connect} />
      <ErrorText>{loadError}</ErrorText>
      {domains?.map((domain) => (
        <DomainSection
          key={domain.domain}
          domain={domain}
          ownPubkey={signer.pubkey}
          api={api}
          onChange={replace}
          onRemove={remove}
        />
      ))}
    </>
  )
}

// The address the domain will receive, written as the user types the domain.
function Composer({ npub, onConnect }: { npub: string; onConnect: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = name.trim().toLowerCase()
    if (!value) return

    setBusy(true)
    setError(null)
    try {
      await onConnect(value)
      setName('')
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="pt-10 pb-14 sm:pt-16">
      <h1 className="font-semibold text-2xl tracking-tight">Connect a domain</h1>
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
  )
}
