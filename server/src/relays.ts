import type { Filter } from 'nostr-tools/filter'
import { SimplePool } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'
import { normalizeBlossomUrl } from './blossom.js'
import { normalizeRelayUrl } from './nostr.js'
import type { KeySigner } from './signer.js'

export const RELAY_LIST_KIND = 10002
export const DM_RELAY_LIST_KIND = 10050
export const BLOSSOM_SERVER_LIST_KIND = 10063
const QUERY_TIMEOUT_MS = 5000
const PUBLISH_TIMEOUT_MS = 10000
// A list is written by whoever holds the recipient key: cap how many relays or
// servers one recipient makes us contact.
const MAX_URLS = 8

// Where a pubkey receives: its DM relays (kind 10050), else its NIP-65 read
// relays (kind 10002), and its Blossom servers (kind 10063).
export interface Inbox {
  relays: string[]
  blossomServers: string[]
}

export interface Subscription {
  close(): void
}

export interface RelayNetwork {
  // Lists the pubkey does not publish come back empty.
  findInbox(pubkey: string): Promise<Inbox>
  // Returns the relays that accepted the event. `auth` answers NIP-42 challenges.
  publish(relays: string[], event: NostrEvent, auth: KeySigner): Promise<string[]>
  // Events are verified, and may arrive more than once.
  subscribe(relays: string[], filter: Filter, auth: KeySigner, onEvent: (event: NostrEvent) => void): Subscription
}

export class NostrRelayNetwork implements RelayNetwork {
  private readonly pool = new SimplePool()

  // The indexer relays are read on every lookup, as an admin may change them.
  constructor(private readonly indexerRelays: () => string[]) {}

  async findInbox(pubkey: string): Promise<Inbox> {
    const lists = await this.query(this.indexerRelays(), {
      kinds: [RELAY_LIST_KIND, DM_RELAY_LIST_KIND, BLOSSOM_SERVER_LIST_KIND],
      authors: [pubkey],
    })

    // NIP-65: a pubkey publishes its lists on its write relays.
    const relayList = latest(lists, RELAY_LIST_KIND, pubkey)
    if (relayList) {
      const fromWriteRelays = await this.query(writeRelaysOf(relayList), {
        kinds: [DM_RELAY_LIST_KIND, BLOSSOM_SERVER_LIST_KIND],
        authors: [pubkey],
      })
      lists.push(...fromWriteRelays)
    }

    return inboxOf(lists, pubkey)
  }

  async publish(relays: string[], event: NostrEvent, auth: KeySigner): Promise<string[]> {
    const results = await Promise.allSettled(
      this.pool.publish(relays, event, { maxWait: PUBLISH_TIMEOUT_MS, onauth: (template) => auth.signEvent(template) }),
    )
    return relays.filter((_, index) => results[index].status === 'fulfilled')
  }

  // Each subscription gets its own connections: a DM relay may serve the gift
  // wraps of only one authenticated key per connection.
  subscribe(relays: string[], filter: Filter, auth: KeySigner, onEvent: (event: NostrEvent) => void): Subscription {
    const pool = new SimplePool({ enablePing: true })
    const subscription = pool.subscribe(relays, filter, {
      onevent: onEvent,
      onauth: (template) => auth.signEvent(template),
    })
    return {
      close: () => {
        subscription.close()
        pool.destroy()
      },
    }
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

export function inboxOf(lists: NostrEvent[], pubkey: string): Inbox {
  const relayList = latest(lists, RELAY_LIST_KIND, pubkey)
  const dmList = latest(lists, DM_RELAY_LIST_KIND, pubkey)
  const serverList = latest(lists, BLOSSOM_SERVER_LIST_KIND, pubkey)
  const dmRelays = dmList ? dmRelaysOf(dmList) : []
  const readRelays = relayList ? readRelaysOf(relayList) : []
  return {
    relays: dmRelays.length ? dmRelays : readRelays,
    blossomServers: serverList ? blossomServersOf(serverList) : [],
  }
}

export function dmRelaysOf(dmList: NostrEvent): string[] {
  return urlsOf(dmList, (tag) => tag[0] === 'relay', normalizeRelayUrl)
}

export function readRelaysOf(relayList: NostrEvent): string[] {
  return urlsOf(relayList, (tag) => tag[0] === 'r' && tag[2] !== 'write', normalizeRelayUrl)
}

export function writeRelaysOf(relayList: NostrEvent): string[] {
  return urlsOf(relayList, (tag) => tag[0] === 'r' && tag[2] !== 'read', normalizeRelayUrl)
}

export function blossomServersOf(serverList: NostrEvent): string[] {
  return urlsOf(serverList, (tag) => tag[0] === 'server', normalizeBlossomUrl)
}

function urlsOf(
  list: NostrEvent,
  keep: (tag: string[]) => boolean,
  normalize: (url: string) => string | null,
): string[] {
  const urls = list.tags
    .filter(keep)
    .map((tag) => (tag[1] ? normalize(tag[1]) : null))
    .filter((url) => url !== null)
  return [...new Set(urls)].slice(0, MAX_URLS)
}
