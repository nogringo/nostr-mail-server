import { type SubmitEvent, useState } from 'react'
import type { Api, Domain } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf } from '../lib/format'
import { Button, CopyButton, ErrorText } from './ui'

interface Props {
  domain: Domain
  api: Api
  onChange: (domain: Domain) => void
}

const ROW_BUTTON =
  'shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 hover:text-ink disabled:opacity-50'

export default function DomainKey({ domain, api, onChange }: Props) {
  const [nsec, setNsec] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const npub = npubOf(domain.bridgePubkey)

  async function reveal() {
    setBusy(true)
    setError(null)
    try {
      setNsec(await api.domainKey(domain.domain))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 className="font-medium">Domain key</h2>
      <p className="mt-1 max-w-xl text-muted text-sm">
        Apps find this key as _smtp@{domain.domain}. It writes the mail the domain receives and opens the mail it sends.
      </p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        <li className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="break-all font-mono text-sm leading-6">{npub}</p>
            <p className="text-muted text-sm">Public key</p>
          </div>
          <CopyButton text={npub} label="the public key" />
        </li>
        <li className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            {nsec ? (
              <p className="break-all font-mono text-sm leading-6">{nsec}</p>
            ) : (
              <p className="text-muted text-sm leading-6">Hidden</p>
            )}
            <p className="text-muted text-sm">Secret key. Whoever has it can read the mail sent from the domain.</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {nsec ? (
              <>
                <CopyButton text={nsec} label="the secret key" />
                <button type="button" onClick={() => setNsec(null)} className={ROW_BUTTON}>
                  Hide
                </button>
              </>
            ) : (
              <button type="button" onClick={reveal} disabled={busy} className={ROW_BUTTON}>
                {busy ? 'Loading' : 'Show'}
              </button>
            )}
          </div>
        </li>
      </ul>
      <ErrorText>{error}</ErrorText>
      {!domain.suspendedAt && <KeyForm domain={domain} api={api} onChange={onChange} />}
    </div>
  )
}

function KeyForm({ domain, api, onChange }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `domain-key-${domain.domain}`

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!value.trim()) return

    setBusy(true)
    setError(null)
    try {
      onChange(await api.replaceDomainKey(domain.domain, value.trim()))
      setValue('')
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <div>
        <label htmlFor={id} className="block text-sm">
          Use your own key
        </label>
        <p className="mt-1 max-w-xl text-muted text-sm">
          Paste the nsec of a key made for this domain only: the server opens every message sent to it and replaces its
          relay lists. The current key stops working for {domain.domain}, so save its nsec first if you need it.
        </p>
        <input
          id={id}
          type="text"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder="nsec1..."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="mt-2 w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!value.trim() || busy}>
          {busy ? 'Replacing' : 'Use this key'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
