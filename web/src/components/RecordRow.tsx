import { useMessages } from '../i18n'
import type { Messages } from '../i18n/en'
import type { CheckStatus, RecordCheck } from '../lib/api'
import { CopyButton, TONES, type Tone } from './ui'

// A record to publish, with what its last check found.
interface RecordLine {
  type: string
  name: string
  value: string
  priority?: number
  // A record that is not required is never flagged.
  required?: boolean
  check: RecordCheck | null
}

export default function RecordRow({ record }: { record: RecordLine }) {
  const t = useMessages().record
  const check = recordStatus(record, t)
  const failed = record.check && record.check.status !== 'ok' && record.check.found.length > 0

  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem]">
      <span className="font-medium font-mono text-muted text-sm leading-6">{record.type}</span>
      <div className="min-w-0 space-y-1 font-mono text-sm leading-6">
        <Field text={record.name} label={t.name(record.type)} />
        <Field text={record.value} label={t.value(record.type)} />
        {record.priority !== undefined && <p className="font-sans text-muted">{t.priority(record.priority)}</p>}
        {failed && (
          <p className="break-all font-sans text-bad">
            {t.found} <span className="font-mono">{record.check?.found.join(', ')}</span>
          </p>
        )}
      </div>
      <p className={`col-start-2 text-sm leading-6 sm:col-start-3 sm:text-right ${TONES[check.tone]}`}>{check.text}</p>
    </li>
  )
}

function Field({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="break-all">{text}</span>
      <CopyButton text={text} label={label} />
    </div>
  )
}

const TONE_OF: Record<CheckStatus, Tone> = { ok: 'ok', missing: 'wait', mismatch: 'bad', error: 'bad' }

function recordStatus(record: RecordLine, t: Messages['record']): { tone: Tone; text: string } {
  if (!record.check) return { tone: 'none', text: t.unchecked }
  if (record.required === false && record.check.status !== 'ok') return { tone: 'none', text: t.optional }
  return { tone: TONE_OF[record.check.status], text: t.status[record.check.status] }
}
