import { type SubmitEvent, useEffect, useState } from 'react'
import type { Address, Api } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub } from '../lib/format'
import { Button, CopyButton, ErrorText } from './ui'

interface Props {
  domain: string
  api: Api
  ownPubkey: string
}

export default function Addresses({ domain, api, ownPubkey }: Props) {
  const [addresses, setAddresses] = useState<Address[]>([])
  const [error, setError] = useState<string | null>(null)
  const ownNpub = npubOf(ownPubkey)

  useEffect(() => {
    api.listAddresses(domain).then(setAddresses, (failure) => setError(describeError(failure)))
  }, [api, domain])

  function keep(address: Address) {
    setAddresses((list) =>
      [...list.filter((other) => other.localPart !== address.localPart), address].sort((left, right) =>
        left.localPart.localeCompare(right.localPart),
      ),
    )
  }

  async function add(localPart: string, pubkey: string, isPrivate: boolean) {
    keep(await api.putAddress(domain, localPart, pubkey, isPrivate))
  }

  async function togglePrivacy(address: Address) {
    setError(null)
    try {
      keep(await api.putAddress(domain, address.localPart, address.pubkey, !address.private))
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  async function remove(localPart: string) {
    setError(null)
    try {
      await api.removeAddress(domain, localPart)
      setAddresses((list) => list.filter((other) => other.localPart !== localPart))
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  const deliveredTo = (pubkey: string) => (pubkey === ownPubkey ? 'your key' : shortNpub(npubOf(pubkey)))

  return (
    <div>
      <p className="text-muted text-sm">
        Mail sent to an address reaches the Nostr key it points at. Anyone can look up the key of a public address
        (NIP-05), while a private one keeps it hidden.
      </p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        <AddressRow address={`${ownNpub}@${domain}`} deliveredTo="your key, always available" />
        {addresses.map((address) => (
          <AddressRow
            key={address.localPart}
            address={address.address}
            deliveredTo={deliveredTo(address.pubkey)}
            isPrivate={address.private}
            onTogglePrivacy={() => togglePrivacy(address)}
            onRemove={() => remove(address.localPart)}
          />
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
      <AddressForm domain={domain} ownNpub={ownNpub} onAdd={add} />
    </div>
  )
}

function AddressRow({
  address,
  deliveredTo,
  isPrivate = false,
  onTogglePrivacy,
  onRemove,
}: {
  address: string
  deliveredTo: string
  isPrivate?: boolean
  onTogglePrivacy?: () => Promise<void>
  onRemove?: () => Promise<void>
}) {
  const [pending, setPending] = useState<'privacy' | 'removal' | null>(null)

  async function run(action: 'privacy' | 'removal', task: () => Promise<void>) {
    setPending(action)
    await task()
    setPending(null)
  }

  const action = 'cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 disabled:opacity-50'

  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <p className="break-all font-mono text-sm leading-6">
          {address}
          {isPrivate && (
            <span className="ml-2 whitespace-nowrap rounded border border-rule px-1.5 py-px font-sans text-muted text-xs">
              Private
            </span>
          )}
        </p>
        <p className="text-muted text-sm">Delivered to {deliveredTo}</p>
      </div>
      <div className="-ml-1.5 flex shrink-0 items-center gap-1 sm:ml-0">
        <CopyButton text={address} label={address} />
        {onTogglePrivacy && (
          <button
            type="button"
            onClick={() => run('privacy', onTogglePrivacy)}
            disabled={pending !== null}
            aria-label={`Make ${address} ${isPrivate ? 'public' : 'private'}`}
            className={`${action} hover:text-ink`}
          >
            {pending === 'privacy' ? 'Saving' : isPrivate ? 'Make public' : 'Make private'}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={() => run('removal', onRemove)}
            disabled={pending !== null}
            aria-label={`Remove ${address}`}
            className={`${action} hover:text-bad`}
          >
            {pending === 'removal' ? 'Removing' : 'Remove'}
          </button>
        )}
      </div>
    </li>
  )
}

function AddressForm({
  domain,
  ownNpub,
  onAdd,
}: {
  domain: string
  ownNpub: string
  onAdd: (localPart: string, pubkey: string, isPrivate: boolean) => Promise<void>
}) {
  const [localPart, setLocalPart] = useState('')
  const [pubkey, setPubkey] = useState(ownNpub)
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `new-address-${domain}`

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!localPart.trim() || !pubkey.trim()) return

    setBusy(true)
    setError(null)
    try {
      await onAdd(localPart.trim().toLowerCase(), pubkey.trim(), isPrivate)
      setLocalPart('')
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
          New address
        </label>
        <div className="mt-1 flex flex-wrap items-baseline font-mono">
          <input
            id={id}
            type="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="name"
            size={Math.max(localPart.length, 4)}
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            className="min-w-0 border-rule border-b-2 bg-transparent caret-accent placeholder:text-rule focus:border-accent focus:outline-none"
          />
          <span className="text-muted">@{domain}</span>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-pubkey`} className="block text-sm">
          Delivered to
        </label>
        <input
          id={`${id}-pubkey`}
          type="text"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          placeholder="npub1..."
          value={pubkey}
          onChange={(event) => setPubkey(event.target.value)}
          className="mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
        />
      </div>
      <label className="flex w-fit cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
          className="mt-1 accent-accent"
        />
        <span>
          Private
          <span className="block text-muted">Mail still arrives, but nobody can look up the key it reaches.</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!localPart.trim() || !pubkey.trim() || busy}>
          {busy ? 'Adding' : 'Add address'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
