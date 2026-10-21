import type { NostrEvent } from 'nostr-tools/pure'
import type { DomainSigners } from './bunker.js'
import { BLOSSOM_SERVER_LIST_KIND, DM_RELAY_LIST_KIND, RELAY_LIST_KIND, type RelayNetwork } from './relays.js'
import { type KeySigner, SignerRefusal, SignerUnavailable } from './signer.js'
import type { DomainRepository, ServerSettings } from './types.js'

type ListsRelays = Pick<ServerSettings, 'domainRelays' | 'indexerRelays'>

// What clients read about a domain key: its relays (NIP-65), its DM relays
// (NIP-17) where they send the mail it relays, and its Blossom servers (BUD-03)
// where they look for the blobs of the mail it writes.
export function domainLists(
  signer: KeySigner,
  blossomServers: string[],
  relays: string[],
  createdAt: number,
): Promise<NostrEvent[]> {
  return Promise.all([
    signer.signEvent({
      kind: RELAY_LIST_KIND,
      created_at: createdAt,
      content: '',
      tags: relays.map((relay) => ['r', relay]),
    }),
    signer.signEvent({
      kind: DM_RELAY_LIST_KIND,
      created_at: createdAt,
      content: '',
      tags: relays.map((relay) => ['relay', relay]),
    }),
    signer.signEvent({
      kind: BLOSSOM_SERVER_LIST_KIND,
      created_at: createdAt,
      content: '',
      tags: blossomServers.map((server) => ['server', server]),
    }),
  ])
}

// Publishes the lists on the domain relays and the indexers. Returns whether
// every list was signed and accepted by at least one relay.
export async function publishDomainLists(
  network: RelayNetwork,
  signer: KeySigner,
  blossomServers: string[],
  { domainRelays, indexerRelays }: ListsRelays,
): Promise<boolean> {
  const targets = [...new Set([...domainRelays, ...indexerRelays])]
  let lists: NostrEvent[]
  try {
    lists = await domainLists(signer, blossomServers, domainRelays, Math.floor(Date.now() / 1000))
  } catch (error) {
    if (error instanceof SignerUnavailable || error instanceof SignerRefusal) return false
    throw error
  }

  const accepted = await Promise.all(lists.map((list) => network.publish(targets, list, signer)))
  return accepted.every((relays) => relays.length > 0)
}

// Every verified domain key announces new relays. Returns the domains whose lists did not go out.
export async function publishEveryDomainLists(
  repo: DomainRepository,
  network: RelayNetwork,
  signers: DomainSigners,
  relays: ListsRelays,
): Promise<string[]> {
  const failed: string[] = []
  for (const domain of await repo.listVerifiedDomains()) {
    if (!(await publishDomainLists(network, signers.forDomain(domain), domain.blossomServers, relays))) {
      failed.push(domain.domain)
    }
  }
  return failed
}
