import type { NostrEvent } from 'nostr-tools/pure'
import { type BlobStore, decryptBlob } from './blossom.js'
import { DomainSigners } from './bunker.js'
import type { DeliveryResult, MailTransport } from './delivery.js'
import { signMessage } from './dkim.js'
import { checkAuthor, checkSender, type OutboundEmail, openOutboundWrap, Refusal } from './outbound.js'
import { QuotaKeeper } from './quotas.js'
import type { RelayNetwork, Subscription } from './relays.js'
import type { SettingsStore } from './settings.js'
import type { KeySigner } from './signer.js'
import type { Domain, DomainRepository, OutboundMessage, RecipientOutcome } from './types.js'

const GIFT_WRAP_KIND = 1059
const TICK_MS = 30_000
// Connections drop silently now and then: every subscription is renewed.
const RENEW_SUBSCRIPTIONS_MS = 10 * 60_000
const PRUNE_MS = 60 * 60_000
// NIP-59 dates a wrap up to two days back, so every subscription reaches that far.
const LOOKBACK_SECONDS = 2 * 24 * 3600 + 3600
const MAX_CLOCK_SKEW_SECONDS = 3600
const BATCH_SIZE = 20
const RETRY_DELAYS_MINUTES = [5, 15, 30, 60, 120, 240, 480]
// RFC 5321 4.5.4.1: a sender gives up after four or five days.
const GIVE_UP_MS = 4 * 24 * 3600_000
// Longer than the lookback, so a wrap seen again is still known.
const KEEP_MS = 7 * 24 * 3600_000
const AUTH_TAG_BYTES = 16

export interface OutboxLogger {
  info(details: object, message: string): void
  error(details: object, message: string): void
}

// Sends the mail clients gift wrap to the domain keys. A wrap is checked and
// queued as it arrives, then delivered over SMTP and retried while the
// recipient's server defers it.
export class Outbox {
  // By domain key, with the signer that answers NIP-42 for it.
  private readonly subscriptions = new Map<string, { subscription: Subscription; signer: KeySigner }>()
  // Wraps handled by this process, with their date, to skip them when relays send them again.
  private readonly seen = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private renewedAt = 0
  // The relays the subscriptions listen on.
  private listening = ''
  private prunedAt = 0
  private draining: Promise<void> | null = null
  private drainAgain = false

  constructor(
    private readonly repo: DomainRepository,
    private readonly relays: RelayNetwork,
    private readonly blobs: BlobStore,
    private readonly transport: MailTransport,
    private readonly settings: SettingsStore,
    private readonly logger: OutboxLogger,
    private readonly signers = new DomainSigners(),
    private readonly quotas = new QuotaKeeper(repo, settings, []),
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    for (const { subscription } of this.subscriptions.values()) subscription.close()
    this.subscriptions.clear()
    await this.draining
  }

  async tick(): Promise<void> {
    try {
      await this.syncSubscriptions()
      await this.deliverDue()
      if (Date.now() - this.prunedAt >= PRUNE_MS) {
        await this.repo.pruneOutboundMessages(new Date(Date.now() - KEEP_MS))
        this.prunedAt = Date.now()
      }
    } catch (error) {
      this.logger.error({ error }, 'The outbox could not run')
    }
  }

  // One subscription per verified domain key, authenticated as that key. A key
  // that moves between the server and a bunker gets a new one, and every key
  // does when the relays change.
  async syncSubscriptions(): Promise<void> {
    const signers = new Map(
      (await this.repo.listVerifiedDomains()).map((domain) => [domain.bridgePubkey, this.signers.forDomain(domain)]),
    )
    const relays = this.settings.outboxRelays()
    const renew = Date.now() - this.renewedAt >= RENEW_SUBSCRIPTIONS_MS || relays.join(' ') !== this.listening
    if (renew) {
      this.renewedAt = Date.now()
      this.listening = relays.join(' ')
    }

    for (const [pubkey, { subscription, signer }] of this.subscriptions) {
      if (renew || signers.get(pubkey) !== signer) {
        subscription.close()
        this.subscriptions.delete(pubkey)
      }
    }
    for (const [pubkey, signer] of signers) {
      if (!this.subscriptions.has(pubkey))
        this.subscriptions.set(pubkey, { subscription: this.subscribe(signer, relays), signer })
    }

    const oldest = now() - LOOKBACK_SECONDS
    for (const [id, createdAt] of this.seen) {
      if (createdAt < oldest) this.seen.delete(id)
    }
  }

  async receive(wrap: NostrEvent, bridgePubkey: string): Promise<void> {
    if (this.seen.has(wrap.id) || wrap.created_at > now() + MAX_CLOCK_SKEW_SECONDS) return
    this.seen.set(wrap.id, wrap.created_at)

    try {
      await this.queue(wrap, bridgePubkey)
    } catch (error) {
      // The relays send it again with the next subscription.
      this.seen.delete(wrap.id)
      throw error
    }
  }

  // Runs until nothing is due. A call made meanwhile runs it once more.
  deliverDue(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true
      return this.draining
    }

    this.draining = (async () => {
      do {
        this.drainAgain = false
        let messages: OutboundMessage[]
        do {
          messages = await this.repo.listDueOutboundMessages(BATCH_SIZE)
          for (const message of messages) await this.attempt(message)
        } while (messages.length === BATCH_SIZE)
      } while (this.drainAgain)
    })().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  private subscribe(signer: KeySigner, relays: string[]): Subscription {
    return this.relays.subscribe(
      relays,
      { kinds: [GIFT_WRAP_KIND], '#p': [signer.pubkey], since: now() - LOOKBACK_SECONDS },
      signer,
      (wrap) => {
        this.receive(wrap, signer.pubkey).catch((error) => {
          this.logger.error({ wrapId: wrap.id, error }, 'A gift wrap could not be queued')
        })
      },
    )
  }

  private async queue(wrap: NostrEvent, bridgePubkey: string): Promise<void> {
    if (await this.repo.hasOutboundMessage(wrap.id)) return
    const domain = await this.repo.findVerifiedDomainByBridgePubkey(bridgePubkey)
    if (!domain) return

    let email: OutboundEmail
    try {
      email = await openOutboundWrap(wrap, this.signers.forDomain(domain))
      await checkSender(this.repo, domain, email)
      const quota = await this.quotas.exceededRecipients(domain, email.recipients.length)
      if (quota !== null) throw new Refusal(`${domain.domain} sends mail to ${quota} recipients a day at most`)
    } catch (error) {
      if (!(error instanceof Refusal)) throw error

      await this.repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey, refusal: error.message })
      this.logger.info({ wrapId: wrap.id, domain: domain.domain, reason: error.message }, 'Refused an email')
      return
    }

    await this.repo.addOutboundMessage({ wrapId: wrap.id, bridgePubkey, wrap, recipients: email.recipients })
    await this.quotas.recordRecipients(domain, email.recipients.length)
    this.logger.info({ wrapId: wrap.id, domain: domain.domain, recipients: email.recipients.length }, 'Queued an email')
    void this.deliverDue().catch((error) => this.logger.error({ error }, 'The outbox could not deliver'))
  }

  private async attempt(message: OutboundMessage): Promise<void> {
    const addresses = message.recipients.map((recipient) => recipient.address)
    const domain = await this.repo.findVerifiedDomainByBridgePubkey(message.bridgePubkey)

    let results: Map<string, DeliveryResult>
    try {
      if (!domain) throw new Refusal('The domain is no longer connected')
      const email = await openOutboundWrap(message.wrap, this.signers.forDomain(domain))
      const mime = await this.loadMime(domain, email)
      await checkAuthor(this.repo, domain, email.senderPubkey, mime)
      results = await this.send(email.mailFrom, addresses, await signMessage(mime, domain))
    } catch (error) {
      const result: DeliveryResult =
        error instanceof Refusal
          ? { status: 'failed', response: error.message }
          : { status: 'deferred', response: (error as Error).message }
      results = new Map(addresses.map((address) => [address, result]))
    }

    const outcomes = new Map<string, RecipientOutcome>()
    for (const { address, attempts } of message.recipients) {
      const result = results.get(address) ?? { status: 'deferred', response: 'Not attempted' }
      outcomes.set(address, outcomeOf(result, attempts, message.receivedAt))
    }
    await this.repo.recordOutcomes(message.wrapId, outcomes)

    const counts = { delivered: 0, pending: 0, failed: 0 }
    for (const outcome of outcomes.values()) counts[outcome.status]++
    const responses = [...new Set([...outcomes.values()].filter(isUndelivered).map((outcome) => outcome.response))]
    this.logger.info(
      { wrapId: message.wrapId, domain: domain?.domain, ...counts, ...(responses.length ? { responses } : {}) },
      'Attempted an email',
    )
  }

  // The blob is looked for on the servers the client uploads to: the domain
  // key's, then the sender's own.
  private async loadMime(domain: Domain, email: OutboundEmail): Promise<Buffer> {
    if ('mime' in email.body) return toCrlf(Buffer.from(email.body.mime))

    const { sha256, key, nonce } = email.body.blob
    const settings = this.settings.current
    const maxBytes = settings.maxMessageBytes + AUTH_TAG_BYTES
    const servers = [...new Set([...domain.blossomServers, ...settings.blossomServers])]
    let bytes = await this.blobs.download(servers, sha256, maxBytes)
    if (!bytes) {
      const { blossomServers } = await this.relays.findInbox(email.senderPubkey)
      const others = blossomServers.filter((server) => !servers.includes(server))
      bytes = await this.blobs.download(others, sha256, maxBytes)
    }
    if (!bytes) throw new Error('The email blob is on no Blossom server')

    try {
      return toCrlf(decryptBlob(bytes, key, nonce))
    } catch {
      throw new Refusal('The email blob cannot be decrypted')
    }
  }

  private async send(mailFrom: string, recipients: string[], message: Buffer): Promise<Map<string, DeliveryResult>> {
    const byDomain = new Map<string, string[]>()
    for (const recipient of recipients) {
      const domain = recipient.slice(recipient.lastIndexOf('@') + 1)
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), recipient])
    }
    const results = await Promise.all(
      [...byDomain].map(([domain, group]) => this.transport.deliver(domain, mailFrom, group, message)),
    )
    return new Map(results.flatMap((result) => [...result]))
  }
}

function outcomeOf(result: DeliveryResult, attempts: number, receivedAt: string): RecipientOutcome {
  if (result.status !== 'deferred') return { status: result.status, response: result.response }
  if (Date.now() - Date.parse(receivedAt) >= GIVE_UP_MS) {
    return { status: 'failed', response: `Gave up after 4 days: ${result.response}` }
  }

  const delay = RETRY_DELAYS_MINUTES[Math.min(attempts, RETRY_DELAYS_MINUTES.length - 1)]
  return { status: 'pending', response: result.response, nextAttemptAt: new Date(Date.now() + delay * 60_000) }
}

function isUndelivered(outcome: RecipientOutcome): boolean {
  return outcome.status !== 'delivered'
}

// SMTP and DKIM work on CRLF lines, clients often write LF.
function toCrlf(message: Buffer): Buffer {
  return Buffer.from(message.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1')
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}
