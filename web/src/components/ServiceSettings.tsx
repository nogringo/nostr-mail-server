import { type ReactNode, type SubmitEvent, useState } from 'react'
import type { ServerSettings } from '../lib/api'
import { describeError } from '../lib/errors'
import { Button, ErrorText } from './ui'

const MEGABYTE = 1024 * 1024

interface Props {
  settings: ServerSettings
  onSave: (changes: Partial<ServerSettings>) => Promise<void>
}

// Each setting is keyed by its value, so that a save shows what the server stored.
export default function ServiceSettings({ settings, onSave }: Props) {
  const { maxMessageBytes, blossomServers, domainRelays, indexerRelays } = settings

  return (
    <div className="space-y-10">
      <SizeSetting
        key={maxMessageBytes}
        bytes={maxMessageBytes}
        onSave={(bytes) => onSave({ maxMessageBytes: bytes })}
      />
      <UrlsSetting
        key={`blossom ${blossomServers.join(' ')}`}
        id="blossom-servers"
        title="Blossom servers"
        note="Given to new domains for the mail too large for a gift wrap, and used by the server's own key. Connected domains keep theirs."
        placeholder="https://"
        urls={blossomServers}
        onSave={(urls) => onSave({ blossomServers: urls })}
      />
      <UrlsSetting
        key={`domain ${domainRelays.join(' ')}`}
        id="domain-relays"
        title="Domain relays"
        note="Every domain key announces them, and the mail to send reaches the server there. Saving publishes the lists of every domain key again. The server keeps listening to a removed relay for seven days, for the clients that have not seen the change."
        placeholder="wss://"
        urls={domainRelays}
        onSave={(urls) => onSave({ domainRelays: urls })}
      />
      <UrlsSetting
        key={`indexer ${indexerRelays.join(' ')}`}
        id="indexer-relays"
        title="Indexer relays"
        note="Where the server looks up the relays and Blossom servers of other keys. Domain keys publish their lists there too."
        placeholder="wss://"
        urls={indexerRelays}
        onSave={(urls) => onSave({ indexerRelays: urls })}
      />
    </div>
  )
}

function SizeSetting({ bytes, onSave }: { bytes: number; onSave: (bytes: number) => Promise<void> }) {
  const current = String(Math.round((bytes / MEGABYTE) * 100) / 100)
  const [megabytes, setMegabytes] = useState(current)

  return (
    <SettingForm
      title="Largest message"
      note="Mail over this size is refused when it arrives, and is not sent when a client hands it over."
      changed={megabytes.trim() !== current && megabytes.trim() !== ''}
      onSave={() => onSave(Math.round(Number(megabytes) * MEGABYTE))}
    >
      <label htmlFor="max-message" className="sr-only">
        Largest message, in MB
      </label>
      <div className="mt-3 flex items-baseline gap-2">
        <input
          id="max-message"
          type="number"
          min={1}
          max={1024}
          step="any"
          value={megabytes}
          onChange={(event) => setMegabytes(event.target.value)}
          className="w-28 rounded-md border border-rule bg-surface px-3 py-2 text-sm"
        />
        <span className="text-muted text-sm">MB</span>
      </div>
    </SettingForm>
  )
}

function UrlsSetting({
  id,
  title,
  note,
  placeholder,
  urls,
  onSave,
}: {
  id: string
  title: string
  note: string
  placeholder: string
  urls: string[]
  onSave: (urls: string[]) => Promise<void>
}) {
  const [text, setText] = useState(urls.join('\n'))
  const entered = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return (
    <SettingForm
      title={title}
      note={note}
      changed={entered.join('\n') !== urls.join('\n')}
      onSave={() => onSave(entered)}
    >
      <label htmlFor={id} className="sr-only">
        {title}, one per line
      </label>
      <textarea
        id={id}
        rows={Math.max(urls.length, entered.length, 2) + 1}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="mt-3 block w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm"
      />
    </SettingForm>
  )
}

function SettingForm({
  title,
  note,
  changed,
  onSave,
  children,
}: {
  title: string
  note: string
  changed: boolean
  onSave: () => Promise<void>
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-muted text-sm">{note}</p>
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={!changed || busy}>
          {busy ? 'Saving' : 'Save'}
        </Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  )
}
