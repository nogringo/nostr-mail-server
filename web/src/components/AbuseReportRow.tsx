import { useEffect, useState } from 'react'
import type { AbuseReport } from '../lib/api'
import { describeError } from '../lib/errors'
import { byteSize, timeAgo } from '../lib/format'
import { Button, ErrorText } from './ui'

// A message can reach the size limit of the server, too much for the page to lay out.
const MAX_SHOWN_CHARS = 200_000

interface Props {
  report: AbuseReport
  load: () => Promise<Blob>
  // The admin lists the reports of every domain.
  showDomain?: boolean
  onDelete?: () => Promise<void>
}

// The message is fetched once opened: listing the reports reads none.
export default function AbuseReportRow({ report, load, showDomain = false, onDelete }: Props) {
  const [message, setMessage] = useState<{ url: string; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = `abuse-report-${report.id}`

  useEffect(() => {
    if (message) return () => URL.revokeObjectURL(message.url)
  }, [message])

  async function toggle() {
    if (message) return setOpen((shown) => !shown)

    setBusy(true)
    setError(null)
    try {
      const blob = await load()
      setMessage({ url: URL.createObjectURL(blob), text: await blob.text() })
      setOpen(true)
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function remove(onDelete: () => Promise<void>) {
    setDeleting(true)
    setError(null)
    try {
      await onDelete()
    } catch (failure) {
      setError(describeError(failure))
      setDeleting(false)
    }
  }

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 break-words font-medium">{report.subject || '(no subject)'}</p>
        <p className="text-muted text-sm" title={new Date(report.receivedAt).toLocaleString()}>
          {timeAgo(report.receivedAt)}
        </p>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted text-sm">
        <span className="break-words">From {report.from || report.mailFrom || 'an empty sender'}</span>
        {showDomain && <span className="break-all">to abuse@{report.domain}</span>}
        <span>{byteSize(report.size)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Button variant="quiet" aria-expanded={open} aria-controls={id} onClick={toggle} disabled={busy}>
          {busy ? 'Loading' : open ? 'Hide message' : 'Show message'}
        </Button>
        {message && (
          <a
            href={message.url}
            download={`abuse-${report.domain}-${report.id}.eml`}
            className="text-muted underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-muted"
          >
            Download .eml
          </a>
        )}
        {onDelete &&
          (confirming ? (
            <>
              <span>Delete this report?</span>
              <Button variant="quiet" className="text-bad" onClick={() => remove(onDelete)} disabled={deleting}>
                {deleting ? 'Deleting' : 'Delete'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          ))}
        <ErrorText>{error}</ErrorText>
      </div>
      {open && message && (
        <div id={id} className="mt-3">
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-rule bg-paper p-3 font-mono text-xs leading-5">
            {message.text.slice(0, MAX_SHOWN_CHARS)}
          </pre>
          {message.text.length > MAX_SHOWN_CHARS && (
            <p className="mt-1 text-muted text-sm">Cut short here: download the .eml to read the rest.</p>
          )}
        </div>
      )}
    </li>
  )
}
