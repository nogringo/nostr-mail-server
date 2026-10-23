import { useEffect, useRef, useState } from 'react'
import { describeError } from '../lib/errors'
import { npubOf, shortNpub } from '../lib/format'
import { type Account, listAccounts } from '../lib/signer'
import { ErrorText } from './ui'

const METHODS: Record<Account['method'], string> = {
  extension: 'Extension',
  bunker: 'Remote signer',
  key: 'Secret key',
}

const ITEM =
  'flex w-full cursor-pointer flex-col items-start rounded px-2 py-1.5 text-left hover:bg-rule/60 disabled:cursor-default disabled:opacity-50'

interface Props {
  pubkey: string
  onSwitch: (pubkey: string) => Promise<void>
  onAdd: () => void
  onSignOut: () => Promise<void>
}

export default function AccountMenu({ pubkey, onSwitch, onAdd, onSignOut }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const accounts = open ? listAccounts() : []
  const method = accounts.find((account) => account.pubkey === pubkey)?.method
  const others = accounts.filter((account) => account.pubkey !== pubkey)

  useEffect(() => {
    if (!open) return
    function closeOnClickOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      toggle.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnClickOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnClickOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  async function run(task: string, action: () => Promise<void>) {
    setBusy(task)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(null)
    }
  }

  function add() {
    setOpen(false)
    onAdd()
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => {
          setError(null)
          setOpen(!open)
        }}
        className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-ink"
      >
        <span className="sm:hidden">Account</span>
        <span className="hidden font-mono sm:inline">{shortNpub(npubOf(pubkey))}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id="account-menu"
          className="absolute top-full right-0 z-10 mt-2 w-72 space-y-2 rounded-md border border-rule bg-surface p-2 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="text-muted text-xs">Signed in as</p>
            <p className="font-mono">{shortNpub(npubOf(pubkey))}</p>
            {method && <p className="text-muted text-xs">{METHODS[method]}</p>}
          </div>
          {others.length > 0 && (
            <div className="border-rule border-t pt-2">
              <p className="px-2 pb-1 text-muted text-xs">Switch to</p>
              {others.map((other) => (
                <button
                  key={other.pubkey}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run(other.pubkey, () => onSwitch(other.pubkey))}
                  className={ITEM}
                >
                  <span className="font-mono">{shortNpub(npubOf(other.pubkey))}</span>
                  <span className="text-muted text-xs">
                    {busy === other.pubkey ? 'Switching' : METHODS[other.method]}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="border-rule border-t pt-2">
            <button type="button" disabled={busy !== null} onClick={add} className={ITEM}>
              Add an account
            </button>
            <button type="button" disabled={busy !== null} onClick={() => run('sign-out', onSignOut)} className={ITEM}>
              {busy === 'sign-out' ? 'Signing out' : 'Sign out'}
            </button>
          </div>
          {error && (
            <div className="px-2 pb-1">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
