import { useState } from 'react'
import { useMessages } from '../i18n'
import type { Address, AddressSettings, Api } from '../lib/api'
import { describeError } from '../lib/errors'
import { AddressForm, AddressRow, type NewAddress } from './Addresses'
import { ErrorText } from './ui'

// The addresses this key creates for itself on the domains other keys share. Each one it adds or removes
// changes the count of its addresses.
export default function SharedAddresses({
  api,
  domains,
  initial,
  onCountChange,
}: {
  api: Api
  domains: string[]
  initial: Address[]
  onCountChange: (change: number) => void
}) {
  const t = useMessages()
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
    const address = await api.putCreatedAddress(domain, localPart, { private: isPrivate })
    if (!addresses.some((other) => other.address === address.address)) onCountChange(1)
    keep(address)
  }

  async function change(address: Address, settings: AddressSettings) {
    setError(null)
    try {
      keep(
        await api.putCreatedAddress(address.domain, address.localPart, {
          private: address.private,
          enabled: address.enabled,
          ...settings,
        }),
      )
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  async function remove(address: Address) {
    setError(null)
    try {
      await api.removeCreatedAddress(address.domain, address.localPart)
      setAddresses((list) => list.filter((other) => other.address !== address.address))
      onCountChange(-1)
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  return (
    <section aria-labelledby="shared-addresses" className="mt-14">
      <h2 id="shared-addresses" className="font-semibold text-xl tracking-tight">
        {t.sharedAddresses.title}
      </h2>
      <p className="mt-1 max-w-xl text-muted text-sm">{t.sharedAddresses.intro}</p>
      {addresses.length > 0 && (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {addresses.map((address) => (
            <AddressRow
              key={address.address}
              address={address.address}
              deliveredTo={t.common.yourKey}
              isPrivate={address.private}
              enabled={address.enabled}
              onTogglePrivacy={() => change(address, { private: !address.private })}
              onToggleEnabled={() => change(address, { enabled: !address.enabled })}
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
