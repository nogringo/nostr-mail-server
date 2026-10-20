import type { Filter } from 'nostr-tools/filter'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { normalizeRelayUrl } from './nostr.js'

const RELAY_LIST_KIND = 10002
const DM_RELAY_LIST_KIND = 10050
const QUERY_TIMEOUT_MS = 5000
const PUBLISH_TIMEOUT_MS = 10000
// A relay list is written by whoever holds the recipient key: cap how many
// relays one recipient makes us contact.
const MAX_RELAYS = 8

export interface RelayNetwork {
  // The pubkey's DM relays (kind 10050), or [] when it publishes none.
  findDmRelays(pubkey: string): Promise<string[]>
  // Returns the relays that accepted the event. `authKey` answers NIP-42 challenges.
  publish(relays: string[], event: NostrEvent, authKey: Uint8Array): Promise<string[]>
}

export class NostrRelayNetwork implements RelayNetwork {
  private readonly pool = new SimplePool()

  constructor(private readonly indexerRelays: string[]) {}

  async findDmRelays(pubkey: string): Promise<string[]> {
    const lists = await this.query(this.indexerRelays, {
      kinds: [RELAY_LIST_KIND, DM_RELAY_LIST_KIND],
      authors: [pubkey],
    })
    const dmList = latest(lists, DM_RELAY_LIST_KIND, pubkey)
    if (dmList) return dmRelaysOf(dmList)

    // NIP-65: the DM relay list may only be on the pubkey's write relays.
    const relayList = latest(lists, RELAY_LIST_KIND, pubkey)
    if (!relayList) return []

    const fromWriteRelays = await this.query(writeRelaysOf(relayList), {
      kinds: [DM_RELAY_LIST_KIND],
      authors: [pubkey],
    })
    const found = latest(fromWriteRelays, DM_RELAY_LIST_KIND, pubkey)
    return found ? dmRelaysOf(found) : []
  }

  async publish(relays: string[], event: NostrEvent, authKey: Uint8Array): Promise<string[]> {
    const results = await Promise.allSettled(
      this.pool.publish(relays, event, {
        maxWait: PUBLISH_TIMEOUT_MS,
        onauth: async (template) => finalizeEvent(template, authKey),
      }),
    )
    return relays.filter((_, index) => results[index].status === 'fulfilled')
  }

  close(): void {
    this.pool.destroy()
  }

  private async query(relays: string[], filter: Filter): Promise<NostrEvent[]> {
    return relays.length ? this.pool.querySync(relays, filter, { maxWait: QUERY_TIMEOUT_MS }) : []
  }
}

// Relays may answer with events the filter did not ask for.
export function latest(events: NostrEvent[], kind: number, pubkey: string): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === kind && event.pubkey === pubkey)
    .reduce<NostrEvent | undefined>(
      (best, event) => (!best || event.created_at > best.created_at ? event : best),
      undefined,
    )
}

export function dmRelaysOf(dmList: NostrEvent): string[] {
  return relayUrls(dmList.tags.filter((tag) => tag[0] === 'relay').map((tag) => tag[1]))
}

export function writeRelaysOf(relayList: NostrEvent): string[] {
  return relayUrls(relayList.tags.filter((tag) => tag[0] === 'r' && tag[2] !== 'read').map((tag) => tag[1]))
}

function relayUrls(values: (string | undefined)[]): string[] {
  const urls = values.map((value) => (value ? normalizeRelayUrl(value) : null)).filter((url) => url !== null)
  return [...new Set(urls)].slice(0, MAX_RELAYS)
}
