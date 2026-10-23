import { useState } from 'react'
import type { Address, Api } from '../lib/api'
import { describeError } from '../lib/errors'
import { AddressForm, AddressRow, type NewAddress } from './Addresses'
import { ErrorText } from './ui'

// The addresses this key creates for itself on the domains other keys share.
export default function SharedAddresses({
  api,
  domains,
  initial,
}: {
  api: Api
  domains: string[]
  initial: Address[]
}) {
  const [addresses, setAddresses] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  function keep(address: Address) {
    setAddresses((list) =>
      [...list.filter((other) => other.address !== address.address), address].sort(
        (left, right) => left.domain.localeCompare(right.domain) || left.localPart.localeCompare(right.localPart),
      ),
    )
  }

  async function add({ domain, localPart, isPrivate }: NewAddress) {
    keep(await api.putCreatedAddress(domain, localPart, isPrivate))
  }

  async function togglePrivacy(address: Address) {
    setError(null)
    try {
      keep(await api.putCreatedAddress(address.domain, address.localPart, !address.private))
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  async function remove(address: Address) {
    setError(null)
    try {
      await api.removeCreatedAddress(address.domain, address.localPart)
      setAddresses((list) => list.filter((other) => other.address !== address.address))
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  return (
    <section aria-labelledby="shared-addresses" className="mt-14">
      <h2 id="shared-addresses" className="font-semibold text-xl tracking-tight">
        Addresses on shared domains
      </h2>
      <p className="mt-1 max-w-xl text-muted text-sm">
        Their owners let anyone create addresses that deliver to their own key. The owner of a domain can still remove
        any address on it.
      </p>
      {addresses.length > 0 && (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {addresses.map((address) => (
            <AddressRow
              key={address.address}
              address={address.address}
              deliveredTo="your key"
              isPrivate={address.private}
              onTogglePrivacy={() => togglePrivacy(address)}
              onRemove={() => remove(address)}
            />
          ))}
        </ul>
      )}
      <ErrorText>{error}</ErrorText>
      {domains.length > 0 && <AddressForm domains={domains} onAdd={add} />}
    </section>
  )
}
