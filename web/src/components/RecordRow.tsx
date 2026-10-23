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
  const check = recordStatus(record)
  const failed = record.check && record.check.status !== 'ok' && record.check.found.length > 0

  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem]">
      <span className="font-medium font-mono text-muted text-sm leading-6">{record.type}</span>
      <div className="min-w-0 space-y-1 font-mono text-sm leading-6">
        <Field text={record.name} label={`${record.type} name`} />
        <Field text={record.value} label={`${record.type} value`} />
        {record.priority !== undefined && <p className="font-sans text-muted">Priority {record.priority}</p>}
        {failed && (
          <p className="break-all font-sans text-bad">
            Found: <span className="font-mono">{record.check?.found.join(', ')}</span>
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

const CHECKS: Record<CheckStatus, { tone: Tone; text: string }> = {
  ok: { tone: 'ok', text: 'Found' },
  missing: { tone: 'wait', text: 'Missing' },
  mismatch: { tone: 'bad', text: 'Different value' },
  error: { tone: 'bad', text: 'Lookup failed' },
}

function recordStatus(record: RecordLine): { tone: Tone; text: string } {
  if (!record.check) return { tone: 'none', text: 'Not checked' }
  if (record.required === false && record.check.status !== 'ok') return { tone: 'none', text: 'Optional' }
  return CHECKS[record.check.status]
}
