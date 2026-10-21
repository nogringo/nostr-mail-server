import { type SubmitEvent, useState } from 'react'
import type { AdminDomain, AllowedKey } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, plural, timeAgo } from '../lib/format'
import { Button, CopyButton, ErrorText } from './ui'

interface Props {
  allowedKeys: AllowedKey[]
  openRegistration: boolean
  domains: AdminDomain[]
  onAllow: (key: string) => Promise<void>
  onDisallow: (pubkey: string) => Promise<void>
  onOpenRegistration: (open: boolean) => Promise<void>
}

const REGISTRATION: [boolean, string][] = [
  [false, 'The admins and the allowed keys'],
  [true, 'Any Nostr key'],
]

export default function AllowedKeys({
  allowedKeys,
  openRegistration,
  domains,
  onAllow,
  onDisallow,
  onOpenRegistration,
}: Props) {
  return (
    <>
      <Registration open={openRegistration} onChange={onOpenRegistration} />
      <h2 className="mt-10 font-medium">
        Allowed keys <span className="font-normal text-muted">{allowedKeys.length}</span>
      </h2>
      <p className="mt-1 text-muted text-sm">
        {openRegistration
          ? 'Not used while any key can connect a domain.'
          : 'A key you remove keeps the domains it already connected: suspend them to stop them.'}
      </p>
      {allowedKeys.length === 0 ? (
        <p className="mt-3 text-sm">No key is allowed yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {allowedKeys.map((allowedKey) => (
            <AllowedKeyRow
              key={allowedKey.pubkey}
              allowedKey={allowedKey}
              claims={domains.filter((domain) => domain.pubkey === allowedKey.pubkey).length}
              onRemove={onDisallow}
            />
          ))}
        </ul>
      )}
      <AllowKeyForm onAllow={onAllow} />
    </>
  )
}

function Registration({ open, onChange }: { open: boolean; onChange: (open: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      await onChange(next)
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset disabled={busy}>
      <legend className="font-medium">Who can connect a domain</legend>
      <div className="mt-2 space-y-1.5 text-sm">
        {REGISTRATION.map(([value, label]) => (
          <label key={label} className="flex w-fit cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="registration"
              checked={open === value}
              onChange={() => choose(value)}
              className="accent-accent"
            />
            {label}
          </label>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </fieldset>
  )
}

function AllowedKeyRow({
  allowedKey,
  claims,
  onRemove,
}: {
  allowedKey: AllowedKey
  claims: number
  onRemove: (pubkey: string) => Promise<void>
}) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const npub = npubOf(allowedKey.pubkey)

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      await onRemove(allowedKey.pubkey)
    } catch (failure) {
      setError(describeError(failure))
      setRemoving(false)
    }
  }

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="break-all font-mono text-sm leading-6">{npub}</p>
        <p className="text-muted text-sm">
          Allowed {timeAgo(allowedKey.allowedAt)}, {plural(claims, 'domain')} claimed
        </p>
        <ErrorText>{error}</ErrorText>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <CopyButton text={npub} label={npub} />
        <button
          type="button"
          onClick={remove}
          disabled={removing}
          aria-label={`Remove ${npub}`}
          className="cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 hover:text-bad disabled:opacity-50"
        >
          {removing ? 'Removing' : 'Remove'}
        </button>
      </div>
    </li>
  )
}

function AllowKeyForm({ onAllow }: { onAllow: (key: string) => Promise<void> }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!key.trim()) return

    setBusy(true)
    setError(null)
    try {
      await onAllow(key.trim())
      setKey('')
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <div>
        <label htmlFor="allow-key" className="block text-sm">
          Allow a key
        </label>
        <input
          id="allow-key"
          type="text"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder="npub1..."
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className="mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!key.trim() || busy}>
          {busy ? 'Allowing' : 'Allow key'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
