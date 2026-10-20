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

  async function add(localPart: string, pubkey: string) {
    const address = await api.putAddress(domain, localPart, pubkey)
    setAddresses((list) =>
      [...list.filter((other) => other.localPart !== address.localPart), address].sort((left, right) =>
        left.localPart.localeCompare(right.localPart),
      ),
    )
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
      <p className="text-muted text-sm">Mail sent to an address reaches the Nostr key it points at.</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        <AddressRow address={`${ownNpub}@${domain}`} deliveredTo="your key, always available" />
        {addresses.map((address) => (
          <AddressRow
            key={address.localPart}
            address={address.address}
            deliveredTo={deliveredTo(address.pubkey)}
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
  onRemove,
}: {
  address: string
  deliveredTo: string
  onRemove?: () => Promise<void>
}) {
  const [removing, setRemoving] = useState(false)

  async function remove() {
    if (!onRemove) return
    setRemoving(true)
    await onRemove()
    setRemoving(false)
  }

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="break-all font-mono text-sm leading-6">{address}</p>
        <p className="text-muted text-sm">Delivered to {deliveredTo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <CopyButton text={address} label={address} />
        {onRemove && (
          <button
            type="button"
            onClick={remove}
            disabled={removing}
            aria-label={`Remove ${address}`}
            className="cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 hover:text-bad disabled:opacity-50"
          >
            {removing ? 'Removing' : 'Remove'}
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
  onAdd: (localPart: string, pubkey: string) => Promise<void>
}) {
  const [localPart, setLocalPart] = useState('')
  const [pubkey, setPubkey] = useState(ownNpub)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `new-address-${domain}`

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!localPart.trim() || !pubkey.trim()) return

    setBusy(true)
    setError(null)
    try {
      await onAdd(localPart.trim().toLowerCase(), pubkey.trim())
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
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!localPart.trim() || !pubkey.trim() || busy}>
          {busy ? 'Adding' : 'Add address'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
