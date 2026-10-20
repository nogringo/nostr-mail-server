import type { NostrEvent } from 'nostr-tools/pure'

export function asNostrEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== 'object') return null

  const event = value as Record<string, unknown>
  if (typeof event.id !== 'string') return null
  if (typeof event.pubkey !== 'string') return null
  if (typeof event.created_at !== 'number') return null
  if (typeof event.kind !== 'number') return null
  if (typeof event.content !== 'string') return null
  if (typeof event.sig !== 'string') return null
  if (!Array.isArray(event.tags) || !event.tags.every(isStringArray)) return null

  return event as unknown as NostrEvent
}

export function findTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) return tag[1]
  }

  return undefined
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
