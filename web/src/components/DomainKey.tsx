import { type SubmitEvent, useState } from 'react'
import { useMessages } from '../i18n'
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
  const t = useMessages()
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
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 className="font-medium">{t.domainKey.title}</h2>
      <p className="mt-1 max-w-xl text-muted text-sm">{t.domainKey.intro(domain.domain)}</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        <li className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="break-all font-mono text-sm leading-6">{npub}</p>
            <p className="text-muted text-sm">{t.domainKey.publicKey}</p>
          </div>
          <CopyButton text={npub} label={t.domainKey.thePublicKey} />
        </li>
        {domain.bridgeSigner === 'bunker' ? (
          <li className="px-4 py-3">
            <p className="text-sm leading-6">{t.domainKey.inBunker}</p>
            <p className="max-w-xl text-muted text-sm">{t.domainKey.bunkerNote}</p>
          </li>
        ) : (
          <li className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              {nsec ? (
                <p className="break-all font-mono text-sm leading-6">{nsec}</p>
              ) : (
                <p className="text-muted text-sm leading-6">{t.domainKey.hidden}</p>
              )}
              <p className="text-muted text-sm">{t.domainKey.secretKey}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {nsec ? (
                <>
                  <CopyButton text={nsec} label={t.domainKey.theSecretKey} />
                  <button type="button" onClick={() => setNsec(null)} className={ROW_BUTTON}>
                    {t.domainKey.hide}
                  </button>
                </>
              ) : (
                <button type="button" onClick={reveal} disabled={busy} className={ROW_BUTTON}>
                  {busy ? t.common.loading : t.domainKey.show}
                </button>
              )}
            </div>
          </li>
        )}
      </ul>
      <ErrorText>{error}</ErrorText>
      {!domain.suspendedAt && <KeyForm domain={domain} api={api} onChange={onChange} />}
    </div>
  )
}

function KeyForm({ domain, api, onChange }: Props) {
  const t = useMessages()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `domain-key-${domain.domain}`
  const key = value.trim()
  const bunker = key.startsWith('bunker://')

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!key) return

    setBusy(true)
    setError(null)
    try {
      onChange(await api.replaceDomainKey(domain.domain, bunker ? { bunker: key } : { nsec: key }))
      setValue('')
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <div>
        <label htmlFor={id} className="block text-sm">
          {t.domainKey.ownKey}
        </label>
        <p className="mt-1 max-w-xl text-muted text-sm">
          {t.domainKey.ownKeyNote(domain.domain, domain.bridgeSigner === 'bunker')}
        </p>
        <p className="mt-1 max-w-xl text-muted text-sm">{t.domainKey.bunkerOnline}</p>
        <input
          id={id}
          type="text"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder={t.domainKey.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="mt-2 w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!key || busy}>
          {busy ? (bunker ? t.domainKey.waitingForBunker : t.domainKey.replacing) : t.domainKey.submit}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
