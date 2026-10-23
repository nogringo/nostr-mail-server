import { type SubmitEvent, useEffect, useId, useState } from 'react'
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

  async function add({ localPart, pubkey, isPrivate }: NewAddress) {
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

  function deliveredTo(address: Address) {
    if (address.pubkey === ownPubkey) return 'your key'
    const key = shortNpub(npubOf(address.pubkey))
    return address.createdBy === address.pubkey ? `${key}, who created it` : key
  }

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
            deliveredTo={deliveredTo(address)}
            isPrivate={address.private}
            onTogglePrivacy={() => togglePrivacy(address)}
            onRemove={() => remove(address.localPart)}
          />
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
      <AddressForm domains={[domain]} defaultPubkey={ownNpub} onAdd={add} />
    </div>
  )
}

export function AddressRow({
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

export interface NewAddress {
  domain: string
  localPart: string
  pubkey: string
  isPrivate: boolean
}

// Without a default pubkey, the form does not ask which key the address delivers to.
export function AddressForm({
  domains,
  defaultPubkey,
  onAdd,
}: {
  domains: string[]
  defaultPubkey?: string
  onAdd: (address: NewAddress) => Promise<void>
}) {
  const [localPart, setLocalPart] = useState('')
  const [domain, setDomain] = useState(domains[0])
  const [pubkey, setPubkey] = useState(defaultPubkey ?? '')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const asksPubkey = defaultPubkey !== undefined
  const ready = localPart.trim() !== '' && (!asksPubkey || pubkey.trim() !== '')

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return

    setBusy(true)
    setError(null)
    try {
      await onAdd({ domain, localPart: localPart.trim().toLowerCase(), pubkey: pubkey.trim(), isPrivate })
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
          {domains.length > 1 ? (
            <>
              <span className="text-muted">@</span>
              <select
                aria-label="Domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                className="min-w-0 cursor-pointer border-rule border-b-2 bg-transparent text-muted focus:border-accent focus:outline-none"
              >
                {domains.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-muted">@{domain}</span>
          )}
        </div>
      </div>
      {asksPubkey && (
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
      )}
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
        <Button type="submit" variant="secondary" disabled={!ready || busy}>
          {busy ? 'Adding' : 'Add address'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
