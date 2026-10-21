import { npubOf } from '../lib/format'
import { CopyButton } from './ui'

// Shown to a key the admin has not allowed, with what to send them.
export default function PrivateServer({ pubkey }: { pubkey: string }) {
  const npub = npubOf(pubkey)

  return (
    <div className="max-w-xl rounded-lg border border-rule bg-surface px-4 py-4">
      <p className="font-medium">This server is private</p>
      <p className="mt-1 text-muted text-sm">
        Its admin chooses the keys that connect domains. Send them your npub to be added.
      </p>
      <p className="mt-3 flex items-center gap-2">
        <span className="min-w-0 break-all font-mono text-sm">{npub}</span>
        <CopyButton text={npub} label="your npub" />
      </p>
    </div>
  )
}
