import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { BLOSSOM_SERVER_LIST_KIND, DM_RELAY_LIST_KIND, RELAY_LIST_KIND, type RelayNetwork } from './relays.js'
import type { DomainConfig } from './types.js'

type ListsConfig = Pick<DomainConfig, 'domainRelays' | 'indexerRelays'>

interface DomainKey {
  bridgePrivateKey: string
  blossomServers: string[]
}

// What clients read about a domain key: its relays (NIP-65), its DM relays
// (NIP-17) where they send the mail it relays, and its Blossom servers (BUD-03)
// where they look for the blobs of the mail it writes.
export function domainLists(domain: DomainKey, relays: string[], createdAt: number): NostrEvent[] {
  const key = hexToBytes(domain.bridgePrivateKey)
  return [
    finalizeEvent(
      { kind: RELAY_LIST_KIND, created_at: createdAt, content: '', tags: relays.map((relay) => ['r', relay]) },
      key,
    ),
    finalizeEvent(
      { kind: DM_RELAY_LIST_KIND, created_at: createdAt, content: '', tags: relays.map((relay) => ['relay', relay]) },
      key,
    ),
    finalizeEvent(
      {
        kind: BLOSSOM_SERVER_LIST_KIND,
        created_at: createdAt,
        content: '',
        tags: domain.blossomServers.map((server) => ['server', server]),
      },
      key,
    ),
  ]
}

// Publishes the lists on the domain relays and the indexers. Returns whether
// every list was accepted by at least one relay.
export async function publishDomainLists(
  network: RelayNetwork,
  domain: DomainKey,
  { domainRelays, indexerRelays }: ListsConfig,
): Promise<boolean> {
  const targets = [...new Set([...domainRelays, ...indexerRelays])]
  const lists = domainLists(domain, domainRelays, Math.floor(Date.now() / 1000))
  const accepted = await Promise.all(
    lists.map((list) => network.publish(targets, list, hexToBytes(domain.bridgePrivateKey))),
  )
  return accepted.every((relays) => relays.length > 0)
}
