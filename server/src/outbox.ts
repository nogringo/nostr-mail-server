import type { NostrEvent } from 'nostr-tools/pure'
import { AUTH_TAG_BYTES, type BlobStore, decryptBlob } from './blossom.js'
import { DomainSigners } from './bunker.js'
import type { DeliveryResult, MailTransport } from './delivery.js'
import { signMessage } from './dkim.js'
import { checkAuthor, checkSender, type OutboundEmail, openOutboundWrap, Refusal } from './outbound.js'
import { QuotaKeeper } from './quotas.js'
import type { RelayNetwork, Subscription } from './relays.js'
import type { SettingsStore } from './settings.js'
import type { KeySigner } from './signer.js'
import type { Domain, DomainRepository, OutboundMessage, RecipientOutcome } from './types.js'

export const GIFT_WRAP_KIND = 1059
export const MAX_CLOCK_SKEW_SECONDS = 3600
const TICK_MS = 30_000
// Connections drop silently now and then: every subscription is renewed.
const RENEW_SUBSCRIPTIONS_MS = 10 * 60_000
const PRUNE_MS = 60 * 60_000
// NIP-59 dates a wrap up to two days back, so every subscription reaches that far.
const LOOKBACK_SECONDS = 2 * 24 * 3600 + 3600
const BATCH_SIZE = 20
const RETRY_DELAYS_MINUTES = [5, 15, 30, 60, 120, 240, 480]
// RFC 5321 4.5.4.1: a sender gives up after four or five days.
const GIVE_UP_MS = 4 * 24 * 3600_000
// Longer than the lookback, so a wrap seen again is still known.
const KEEP_MS = 7 * 24 * 3600_000
// A client may upload a blob well before its wrap gets through, a bunker that is away for instance.
const UNCLAIMED_BLOB_MS = 24 * 3600_000

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
  // Wraps being checked, with their answer.
  private readonly handling = new Map<string, Promise<string | null>>()
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
        await this.repo.pruneBlobs(new Date(Date.now() - UNCLAIMED_BLOB_MS))
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
      if (relays.length && !this.subscriptions.has(pubkey))
        this.subscriptions.set(pubkey, { subscription: this.subscribe(signer, relays), signer })
    }

    const oldest = now() - LOOKBACK_SECONDS
    for (const [id, createdAt] of this.seen) {
      if (createdAt < oldest) this.seen.delete(id)
    }
  }

  // Returns why the wrap is refused, or null once it is queued or was handled before. A wrap that fails to
  // be checked is not seen: the relays send it again with the next subscription.
  receive(wrap: NostrEvent, bridgePubkey: string): Promise<string | null> {
    const handling = this.handling.get(wrap.id)
    if (handling) return handling
    if (this.seen.has(wrap.id) || wrap.created_at > now() + MAX_CLOCK_SKEW_SECONDS) return Promise.resolve(null)

    const answer = this.queue(wrap, bridgePubkey)
      .then((refusal) => {
        this.seen.set(wrap.id, wrap.created_at)
        return refusal
      })
      .finally(() => this.handling.delete(wrap.id))
    this.handling.set(wrap.id, answer)
    return answer
  }

  // An email waiting for the blob that just came goes out at once.
  async blobUploaded(sha256: string): Promise<void> {
    if (await this.repo.wakeBlobRecipients(sha256)) await this.deliverDue()
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

  private async queue(wrap: NostrEvent, bridgePubkey: string): Promise<string | null> {
    if (await this.repo.hasOutboundMessage(wrap.id)) return null
    const domain = await this.repo.findVerifiedDomainByBridgePubkey(bridgePubkey)
    if (!domain) return null

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
      return error.message
    }

    const blobSha256 = 'blob' in email.body ? email.body.blob.sha256 : undefined
    await this.repo.addOutboundMessage({
      wrapId: wrap.id,
      bridgePubkey,
      wrap,
      recipients: email.recipients,
      blobSha256,
    })
    await this.quotas.recordRecipients(domain, email.recipients.length)
    this.logger.info({ wrapId: wrap.id, domain: domain.domain, recipients: email.recipients.length }, 'Queued an email')
    void this.deliverDue().catch((error) => this.logger.error({ error }, 'The outbox could not deliver'))
    return null
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

  // The blob is on the server when the client read the domain's current lists.
  // Otherwise it is looked for on the servers the client uploads to: those the
  // domain key announced before, then the sender's own.
  private async loadMime(domain: Domain, email: OutboundEmail): Promise<Buffer> {
    if ('mime' in email.body) return toCrlf(Buffer.from(email.body.mime))

    const { blob } = email.body
    const { sha256 } = blob
    const settings = this.settings.current
    const maxBytes = settings.maxMessageBytes + AUTH_TAG_BYTES
    const servers = [...new Set([...domain.blossomServers, ...settings.blossomServers])]
    let bytes = (await this.repo.findBlob(sha256))?.data ?? (await this.blobs.download(servers, sha256, maxBytes))
    if (!bytes) {
      const { blossomServers } = await this.relays.findInbox(email.senderPubkey)
      const others = blossomServers.filter((server) => !servers.includes(server))
      bytes = await this.blobs.download(others, sha256, maxBytes)
    }
    if (!bytes) throw new Error('The email blob is on no Blossom server')
    if (!('key' in blob)) return toCrlf(bytes)

    try {
      return toCrlf(decryptBlob(bytes, blob.key, blob.nonce))
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
