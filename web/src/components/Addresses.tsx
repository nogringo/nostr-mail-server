import { type SubmitEvent, useEffect, useId, useState } from 'react'
import { useLocale, useMessages } from '../i18n'
import type { Address, AddressSettings, Api, DeletedAddress } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub } from '../lib/format'
import { Button, CopyButton, ErrorText } from './ui'

interface Props {
  domain: string
  api: Api
  ownPubkey: string
}

const ACTION = 'cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 disabled:opacity-50'

const byLocalPart = (left: { localPart: string }, right: { localPart: string }) =>
  left.localPart.localeCompare(right.localPart)

export default function Addresses({ domain, api, ownPubkey }: Props) {
  const t = useMessages()
  const locale = useLocale()
  const [addresses, setAddresses] = useState<Address[]>([])
  const [deleted, setDeleted] = useState<DeletedAddress[]>([])
  const [error, setError] = useState<string | null>(null)
  const ownNpub = npubOf(ownPubkey)

  useEffect(() => {
    api.listAddresses(domain).then(
      (list) => {
        setAddresses(list.addresses)
        setDeleted(list.deletedAddresses)
      },
      (failure) => setError(describeError(failure, t.errors)),
    )
  }, [api, domain, t])

  function keep(address: Address) {
    setAddresses((list) =>
      [...list.filter((other) => other.localPart !== address.localPart), address].sort(byLocalPart),
    )
  }

  async function add({ localPart, pubkey, isPrivate }: NewAddress) {
    keep(await api.putAddress(domain, localPart, [pubkey], { private: isPrivate }))
  }

  async function save(address: Address, pubkeys: string[], settings: AddressSettings = {}) {
    keep(
      await api.putAddress(domain, address.localPart, pubkeys, {
        private: address.private,
        enabled: address.enabled,
        ...settings,
      }),
    )
  }

  async function change(address: Address, settings: AddressSettings) {
    setError(null)
    try {
      await save(address, address.pubkeys, settings)
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  async function remove(localPart: string) {
    setError(null)
    try {
      await api.removeAddress(domain, localPart)
      setAddresses((list) => list.filter((other) => other.localPart !== localPart))
      const entry = { domain, localPart, address: `${localPart}@${domain}`, deletedAt: new Date().toISOString() }
      setDeleted((list) => [...list, entry].sort(byLocalPart))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  async function allow(localPart?: string) {
    setError(null)
    try {
      await api.allowDeletedAddresses(domain, localPart)
      setDeleted((list) => (localPart === undefined ? [] : list.filter((other) => other.localPart !== localPart)))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    }
  }

  function deliveredTo(address: Address) {
    const keys = address.pubkeys.map((pubkey) => {
      if (pubkey === ownPubkey) return t.common.yourKey
      const key = shortNpub(npubOf(pubkey))
      return address.createdBy === pubkey ? t.addresses.createdBy(key) : key
    })
    return new Intl.ListFormat(locale).format(keys)
  }

  return (
    <div>
      <p className="text-muted text-sm">{t.addresses.intro}</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        <AddressRow address={`${ownNpub}@${domain}`} deliveredTo={t.common.yourKeyAlwaysAvailable} />
        {addresses.map((address) => {
          const several = address.pubkeys.length > 1
          return (
            <AddressRow
              key={address.localPart}
              address={address.address}
              deliveredTo={deliveredTo(address)}
              isPrivate={address.private || several}
              enabled={address.enabled}
              onTogglePrivacy={several ? undefined : () => change(address, { private: !address.private })}
              onToggleEnabled={() => change(address, { enabled: !address.enabled })}
              onRemove={() => remove(address.localPart)}
              keys={{
                pubkeys: address.pubkeys,
                ownPubkey,
                onSave: (pubkeys) => save(address, pubkeys),
              }}
            />
          )
        })}
      </ul>
      <ErrorText>{error}</ErrorText>
      <AddressForm domains={[domain]} defaultPubkey={ownNpub} onAdd={add} />
      {deleted.length > 0 && <DeletedAddresses deleted={deleted} onAllow={allow} />}
    </div>
  )
}

function DeletedAddresses({
  deleted,
  onAllow,
}: {
  deleted: DeletedAddress[]
  onAllow: (localPart?: string) => Promise<void>
}) {
  const t = useMessages().addresses
  const [busy, setBusy] = useState(false)

  async function allowAll() {
    setBusy(true)
    await onAllow()
    setBusy(false)
  }

  return (
    <details className="mt-8 text-sm">
      <summary className="w-fit cursor-pointer text-muted hover:text-ink">{t.deleted(deleted.length)}</summary>
      <p className="mt-2 max-w-xl text-muted">{t.deletedNote}</p>
      <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {deleted.map((entry) => (
          <DeletedRow key={entry.localPart} address={entry.address} onAllow={() => onAllow(entry.localPart)} />
        ))}
      </ul>
      {deleted.length > 1 && (
        <Button variant="quiet" className="mt-3" onClick={allowAll} disabled={busy}>
          {busy ? t.allowing : t.allowAll}
        </Button>
      )}
    </details>
  )
}

function DeletedRow({ address, onAllow }: { address: string; onAllow: () => Promise<void> }) {
  const t = useMessages().addresses
  const [busy, setBusy] = useState(false)

  async function allow() {
    setBusy(true)
    await onAllow()
    setBusy(false)
  }

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2">
      <span className="min-w-0 break-all font-mono leading-6">{address}</span>
      <button
        type="button"
        onClick={allow}
        disabled={busy}
        aria-label={t.allowAgainLabel(address)}
        className={`${ACTION} shrink-0 hover:text-ink`}
      >
        {busy ? t.allowing : t.allowAgain}
      </button>
    </li>
  )
}

interface Keys {
  pubkeys: string[]
  ownPubkey: string
  // Throws when the server refuses them.
  onSave: (pubkeys: string[]) => Promise<void>
}

export function AddressRow({
  address,
  deliveredTo,
  isPrivate = false,
  enabled = true,
  onTogglePrivacy,
  onToggleEnabled,
  onRemove,
  keys,
}: {
  address: string
  deliveredTo: string
  isPrivate?: boolean
  enabled?: boolean
  onTogglePrivacy?: () => Promise<void>
  onToggleEnabled?: () => Promise<void>
  onRemove?: () => Promise<void>
  keys?: Keys
}) {
  const t = useMessages()
  const [pending, setPending] = useState<'privacy' | 'state' | 'removal' | null>(null)
  const [editingKeys, setEditingKeys] = useState(false)
  const keysId = useId()

  async function run(action: 'privacy' | 'state' | 'removal', task: () => Promise<void>) {
    setPending(action)
    await task()
    setPending(null)
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="break-all font-mono text-sm leading-6">
            {address}
            {isPrivate && <Tag>{t.addresses.private}</Tag>}
            {!enabled && <Tag>{t.addresses.disabled}</Tag>}
          </p>
          <p className="text-muted text-sm">{t.common.deliveredTo(deliveredTo)}</p>
        </div>
        <div className="-ml-1.5 flex shrink-0 flex-wrap items-center gap-1 sm:ml-0">
          <CopyButton text={address} label={address} />
          {onTogglePrivacy && (
            <button
              type="button"
              onClick={() => run('privacy', onTogglePrivacy)}
              disabled={pending !== null}
              aria-label={t.addresses.privacyLabel(address, isPrivate)}
              className={`${ACTION} hover:text-ink`}
            >
              {pending === 'privacy' ? t.common.saving : isPrivate ? t.addresses.makePublic : t.addresses.makePrivate}
            </button>
          )}
          {onToggleEnabled && (
            <button
              type="button"
              onClick={() => run('state', onToggleEnabled)}
              disabled={pending !== null}
              aria-label={t.addresses.stateLabel(address, enabled)}
              className={`${ACTION} hover:text-ink`}
            >
              {pending === 'state' ? t.common.saving : enabled ? t.addresses.disable : t.addresses.enable}
            </button>
          )}
          {keys && (
            <button
              type="button"
              onClick={() => setEditingKeys(!editingKeys)}
              aria-expanded={editingKeys}
              aria-controls={keysId}
              aria-label={t.addresses.keysLabel(address)}
              className={`${ACTION} hover:text-ink`}
            >
              {t.addresses.keys}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => run('removal', onRemove)}
              disabled={pending !== null}
              aria-label={t.addresses.removeLabel(address)}
              className={`${ACTION} hover:text-bad`}
            >
              {pending === 'removal' ? t.common.removing : t.common.remove}
            </button>
          )}
        </div>
      </div>
      {keys && editingKeys && <KeyEditor id={keysId} address={address} keys={keys} />}
    </li>
  )
}

// Saves on each change. The last key cannot be removed: the address is removed instead.
function KeyEditor({ id, address, keys }: { id: string; address: string; keys: Keys }) {
  const t = useMessages()
  const [key, setKey] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  async function save(pubkeys: string[], action: string): Promise<boolean> {
    setPending(action)
    setError(null)
    try {
      await keys.onSave(pubkeys)
      return true
    } catch (failure) {
      setError(describeError(failure, t.errors))
      return false
    } finally {
      setPending(null)
    }
  }

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (key.trim() && (await save([...keys.pubkeys, key.trim()], 'add'))) setKey('')
  }

  return (
    <div id={id} className="mt-3 border-rule border-t pt-3">
      <p className="max-w-xl text-muted text-sm">{t.addresses.keysNote}</p>
      <ul className="mt-3 space-y-1">
        {keys.pubkeys.map((pubkey) => {
          const npub = npubOf(pubkey)
          return (
            <li key={pubkey} className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-all font-mono text-sm leading-6">
                {npub}
                {pubkey === keys.ownPubkey && <Tag>{t.common.yourKey}</Tag>}
              </span>
              {keys.pubkeys.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    save(
                      keys.pubkeys.filter((other) => other !== pubkey),
                      pubkey,
                    )
                  }
                  disabled={pending !== null}
                  aria-label={t.addresses.removeKeyLabel(npub, address)}
                  className={`${ACTION} shrink-0 hover:text-bad`}
                >
                  {pending === pubkey ? t.addresses.removingKey : t.addresses.removeKey}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <form onSubmit={add} className="mt-3">
        <label htmlFor={inputId} className="block text-sm">
          {t.addresses.newKey}
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id={inputId}
            type="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder="npub1..."
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="min-w-0 flex-1 basis-64 rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
          />
          <Button type="submit" variant="secondary" disabled={!key.trim() || pending !== null}>
            {pending === 'add' ? t.addresses.adding : t.addresses.addKey}
          </Button>
        </div>
      </form>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function Tag({ children }: { children: string }) {
  return (
    <span className="ml-2 whitespace-nowrap rounded border border-rule px-1.5 py-px font-sans text-muted text-xs">
      {children}
    </span>
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
  const t = useMessages()
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
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <div>
        <label htmlFor={id} className="block text-sm">
          {t.addresses.newAddress}
        </label>
        <div className="mt-1 flex flex-wrap items-baseline font-mono">
          <input
            id={id}
            type="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.addresses.namePlaceholder}
            size={Math.max(localPart.length, 4)}
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            className="min-w-0 border-rule border-b-2 bg-transparent caret-accent placeholder:text-rule focus:border-accent focus:outline-none"
          />
          {domains.length > 1 ? (
            <>
              <span className="text-muted">@</span>
              <select
                aria-label={t.common.domain}
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
            {t.addresses.deliveredTo}
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
          {t.addresses.private}
          <span className="block text-muted">{t.addresses.privateNote}</span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!ready || busy}>
          {busy ? t.addresses.adding : t.addresses.add}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
