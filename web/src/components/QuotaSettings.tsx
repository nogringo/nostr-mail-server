import { type SubmitEvent, useState } from 'react'
import { useMessages } from '../i18n'
import { type KeyQuotas, QUOTA_NAMES, type QuotaName, type Quotas } from '../lib/api'
import { describeError } from '../lib/errors'
import { npubOf } from '../lib/format'
import { Button, ErrorText } from './ui'

const ACTION = 'cursor-pointer rounded px-1.5 py-0.5 text-muted text-sm hover:bg-rule/60 disabled:opacity-50'
const NUMBER_INPUT = 'rounded-md border border-rule bg-surface px-3 py-2 text-sm disabled:opacity-50'

interface Props {
  quotas: Quotas
  keyQuotas: KeyQuotas[]
  onSave: (quotas: Quotas) => Promise<void>
  onSetKey: (key: string, quotas: Partial<Quotas>) => Promise<void>
  onRemoveKey: (pubkey: string) => Promise<void>
}

export default function QuotaSettings({ quotas, keyQuotas, onSave, onSetKey, onRemoveKey }: Props) {
  const t = useMessages().quotas

  return (
    <>
      <ServerQuotas key={JSON.stringify(quotas)} quotas={quotas} onSave={onSave} />
      <h2 className="mt-10 font-medium">
        {t.keysTitle} <span className="font-normal text-muted">{keyQuotas.length}</span>
      </h2>
      <p className="mt-1 text-muted text-sm">{t.keysNote}</p>
      {keyQuotas.length === 0 ? (
        <p className="mt-3 text-sm">{t.keysEmpty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {keyQuotas.map((entry) => (
            <KeyQuotasRow
              key={`${entry.pubkey} ${entry.updatedAt}`}
              entry={entry}
              server={quotas}
              onSave={(changes) => onSetKey(entry.pubkey, changes)}
              onRemove={() => onRemoveKey(entry.pubkey)}
            />
          ))}
        </ul>
      )}
      <h3 className="mt-6 text-sm">{t.giveKey}</h3>
      <KeyQuotasForm server={quotas} onSave={onSetKey} />
    </>
  )
}

// An empty field is no limit.
function ServerQuotas({ quotas, onSave }: { quotas: Quotas; onSave: (quotas: Quotas) => Promise<void> }) {
  const t = useMessages()
  const current = mapQuotas((name) => (quotas[name] === null ? '' : String(quotas[name])))
  const [values, setValues] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = QUOTA_NAMES.some((name) => values[name].trim() !== current[name])

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(mapQuotas((name) => (values[name].trim() === '' ? null : Number(values[name]))))
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="font-medium">{t.quotas.serverTitle}</h2>
      <p className="mt-1 text-muted text-sm">{t.quotas.serverNote}</p>
      <div className="mt-4 space-y-5">
        {QUOTA_NAMES.map((name) => (
          <div key={name}>
            <label htmlFor={`quota-${name}`} className="block text-sm">
              {t.quotas.names[name]}
            </label>
            <input
              id={`quota-${name}`}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              placeholder={t.quotas.noLimit}
              value={values[name]}
              onChange={(event) => setValues({ ...values, [name]: event.target.value })}
              className={`mt-1 w-36 ${NUMBER_INPUT}`}
            />
            <p className="mt-1 max-w-xl text-muted text-sm">{t.quotas.notes[name]}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!changed || busy}>
          {busy ? t.common.saving : t.common.save}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}

function KeyQuotasRow({
  entry,
  server,
  onSave,
  onRemove,
}: {
  entry: KeyQuotas
  server: Quotas
  onSave: (quotas: Partial<Quotas>) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const t = useMessages()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const npub = npubOf(entry.pubkey)
  const summary = QUOTA_NAMES.filter((name) => name in entry.quotas)
    .map((name) => t.quotas.item(t.quotas.names[name], describeLimit(entry.quotas[name] ?? null, t.quotas.unlimited)))
    .join(', ')

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      await onRemove()
    } catch (failure) {
      setError(describeError(failure, t.errors))
      setRemoving(false)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all font-mono text-sm leading-6">{npub}</p>
          <p className="text-muted text-sm">{summary}</p>
          <ErrorText>{error}</ErrorText>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
            aria-label={t.quotas.changeLabel(npub)}
            className={`${ACTION} hover:text-ink`}
          >
            {t.quotas.change}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={removing}
            aria-label={t.quotas.removeLabel(npub)}
            className={`${ACTION} hover:text-bad`}
          >
            {removing ? t.common.removing : t.common.remove}
          </button>
        </div>
      </div>
      {editing && (
        <KeyQuotasForm
          pubkey={entry.pubkey}
          initial={entry.quotas}
          server={server}
          onSave={(_, quotas) => onSave(quotas)}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  )
}

// Each quota is the server's while its field is empty, unless it is set to no limit.
interface Field {
  unlimited: boolean
  value: string
}

function KeyQuotasForm({
  pubkey,
  initial = {},
  server,
  onSave,
  onCancel,
}: {
  pubkey?: string
  initial?: Partial<Quotas>
  server: Quotas
  onSave: (key: string, quotas: Partial<Quotas>) => Promise<void>
  onCancel?: () => void
}) {
  const t = useMessages()
  const blank = () => mapQuotas<Field>((name) => fieldOf(initial, name))
  const [key, setKey] = useState('')
  const [fields, setFields] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const quotas = quotasOf(fields)
  const ready = (pubkey !== undefined || key.trim() !== '') && Object.keys(quotas).length > 0
  const id = pubkey ?? 'new'

  function change(name: QuotaName, field: Partial<Field>) {
    setFields({ ...fields, [name]: { ...fields[name], ...field } })
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return

    setBusy(true)
    setError(null)
    try {
      await onSave(pubkey ?? key.trim(), quotas)
      setKey('')
      setFields(blank())
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-4">
      {pubkey === undefined && (
        <div>
          <label htmlFor="quota-key" className="block text-sm">
            {t.quotas.key}
          </label>
          <input
            id="quota-key"
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
      )}
      <p className="text-muted text-sm">{t.quotas.fieldsNote}</p>
      <div className="space-y-3">
        {QUOTA_NAMES.map((name) => (
          <div key={name}>
            <label htmlFor={`quota-${id}-${name}`} className="block text-sm">
              {t.quotas.names[name]}
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
              <input
                id={`quota-${id}-${name}`}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                placeholder={t.quotas.server(describeLimit(server[name], t.quotas.unlimited))}
                disabled={fields[name].unlimited}
                value={fields[name].unlimited ? '' : fields[name].value}
                onChange={(event) => change(name, { value: event.target.value })}
                className={`w-48 ${NUMBER_INPUT}`}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fields[name].unlimited}
                  onChange={(event) => change(name, { unlimited: event.target.checked })}
                  className="accent-accent"
                />
                {t.quotas.noLimit}
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!ready || busy}>
          {busy ? t.common.saving : t.common.save}
        </Button>
        {onCancel && (
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            {t.common.cancel}
          </Button>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}

function mapQuotas<T>(value: (name: QuotaName) => T): Record<QuotaName, T> {
  return Object.fromEntries(QUOTA_NAMES.map((name) => [name, value(name)])) as Record<QuotaName, T>
}

function fieldOf(quotas: Partial<Quotas>, name: QuotaName): Field {
  const limit = quotas[name]
  return { unlimited: limit === null, value: limit === undefined || limit === null ? '' : String(limit) }
}

// The quotas the fields set: an empty field is left out.
function quotasOf(fields: Record<QuotaName, Field>): Partial<Quotas> {
  const quotas: Partial<Quotas> = {}
  for (const name of QUOTA_NAMES) {
    const { unlimited, value } = fields[name]
    if (unlimited) quotas[name] = null
    else if (value.trim() !== '') quotas[name] = Number(value)
  }
  return quotas
}

function describeLimit(limit: number | null, unlimited: string): string {
  return limit === null ? unlimited : String(limit)
}
