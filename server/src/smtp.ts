import type { DNSResolver } from 'mailauth'
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerDataStream,
  type SMTPServerEnvelope,
  type SMTPServerSession,
} from 'smtp-server'
import { ABUSE_LOCAL_PART, findAddressPubkey, parseEmailAddress } from './address.js'
import { authenticateMessage, dmarcRejection, removeForgedResults, summarize } from './authentication.js'
import { type BlobStore, type EncryptedBlob, encryptBlob } from './blossom.js'
import { DomainSigners } from './bunker.js'
import {
  emailIdOf,
  type InboundEmail,
  MAX_BUNKER_INLINE_MIME_BYTES,
  MAX_INLINE_MIME_BYTES,
  wrapInboundEmail,
} from './inbound.js'
import { decodedField } from './mime.js'
import type { Inbox, RelayNetwork } from './relays.js'
import { type KeySigner, localSigner, SignerRefusal, SignerUnavailable } from './signer.js'
import type { TlsCredentials } from './tls.js'
import type { AppConfig, Domain, DomainRepository } from './types.js'

const MAX_RECIPIENTS = 50
// RFC 5321 4.5.3.2.7: a server waits 5 minutes for the next command. The timer
// also runs while a message is delivered after DATA, uploads included.
const SOCKET_TIMEOUT_MS = 5 * 60 * 1000
// The From and Subject an abuse report is listed with on the site.
const MAX_LISTED_CHARS = 300

// The key that writes the mail to Nostr, and the Blossom servers it lists.
interface Writer {
  signer: KeySigner
  blossomServers: string[]
  maxInlineMimeBytes: number
}

interface Target {
  writer: Writer
  pubkey: string
}

type Recipient = Target & Inbox

type SmtpConfig = Pick<AppConfig, 'mxHost' | 'maxMessageBytes' | 'adminPubkeys' | 'blossomServers'> & {
  // The server's own key, which writes the complaints no domain key is left for.
  serverPrivateKey: string
}

export interface SmtpLogger {
  info(details: object, message: string): void
  error(details: object, message: string): void
}

const silent: SmtpLogger = { info() {}, error() {} }

type SmtpError = Error & { responseCode?: number }

// Receives mail for the verified domains and publishes it to the recipients
// before answering DATA: there is no queue, a failure is retried by the sender.
export function createSmtpServer(
  repo: DomainRepository,
  relays: RelayNetwork,
  blobs: BlobStore,
  resolver: DNSResolver,
  { mxHost, maxMessageBytes, adminPubkeys, blossomServers, serverPrivateKey }: SmtpConfig,
  {
    logger = silent,
    tls,
    signers = new DomainSigners(),
  }: { logger?: SmtpLogger; tls?: TlsCredentials; signers?: DomainSigners } = {},
): SMTPServer {
  // Keyed by envelope, which the server replaces for every transaction.
  const recipients = new WeakMap<SMTPServerEnvelope, Recipient[]>()
  const abuseDomains = new WeakMap<SMTPServerEnvelope, Set<string>>()
  const serverWriter: Writer = {
    signer: localSigner(serverPrivateKey),
    blossomServers,
    maxInlineMimeBytes: MAX_INLINE_MIME_BYTES,
  }

  function domainWriter(domain: Domain): Writer {
    return {
      signer: signers.forDomain(domain),
      blossomServers: domain.blossomServers,
      maxInlineMimeBytes: domain.bridgeBunker ? MAX_BUNKER_INLINE_MIME_BYTES : MAX_INLINE_MIME_BYTES,
    }
  }

  async function acceptRecipient(address: SMTPServerAddress, session: SMTPServerSession): Promise<void> {
    const accepted = recipients.get(session.envelope) ?? []
    if (accepted.length >= MAX_RECIPIENTS) throw smtpError(452, '4.5.3 Too many recipients')

    const parsed = parseEmailAddress(address.address)
    const abuse = parsed?.localPart === ABUSE_LOCAL_PART
    const targets = !parsed
      ? null
      : abuse
        ? await findComplaintTargets(parsed.domain)
        : await findTargets(parsed.domain, parsed.localPart)
    if (!parsed || !targets) throw smtpError(550, '5.1.1 No such user here')

    const added = targets.filter((target) => !accepted.some((recipient) => recipient.pubkey === target.pubkey))
    const inboxes = await Promise.all(added.map((target) => relays.findInbox(target.pubkey)))
    // A complaint is kept on the server anyway, and goes on to whoever can get it.
    if (!abuse && inboxes.some((inbox) => !inbox.relays.length)) {
      throw smtpError(450, '4.2.0 The recipient has no Nostr inbox relays yet')
    }

    added.forEach((target, index) => {
      if (inboxes[index].relays.length) accepted.push({ ...target, ...inboxes[index] })
      else logger.info({ session: session.id, pubkey: target.pubkey }, 'An abuse report recipient has no inbox relays')
    })
    recipients.set(session.envelope, accepted)
    if (abuse) {
      abuseDomains.set(session.envelope, (abuseDomains.get(session.envelope) ?? new Set()).add(parsed.domain))
    }
  }

  async function findTargets(name: string, localPart: string): Promise<Target[] | null> {
    const domain = await repo.findVerifiedDomain(name)
    const pubkey = domain ? await findAddressPubkey(repo, name, localPart) : null
    return domain && pubkey ? [{ writer: domainWriter(domain), pubkey }] : null
  }

  // A complaint reaches the admins, and the owner of the domain while it has one,
  // whoever abuse@ is declared to. The server takes complaints about itself and
  // about every domain it sent mail for, suspended or released since.
  async function findComplaintTargets(name: string): Promise<Target[] | null> {
    const owned = await repo.findOwnedDomain(name)
    if (owned) {
      const declared = await findAddressPubkey(repo, name, ABUSE_LOCAL_PART)
      const pubkeys = [declared, owned.pubkey, ...adminPubkeys].filter((pubkey) => pubkey !== null)
      return [...new Set(pubkeys)].map((pubkey) => ({ writer: domainWriter(owned), pubkey }))
    }
    if (name !== mxHost && !(await repo.hasServedDomain(name)) && !(await repo.findSuspension(name))) return null

    return adminPubkeys.map((pubkey) => ({ writer: serverWriter, pubkey }))
  }

  async function deliver(stream: SMTPServerDataStream, session: SMTPServerSession): Promise<string> {
    const message = await readMessage(stream)
    if (stream.sizeExceeded) throw smtpError(552, `5.3.4 Messages are limited to ${maxMessageBytes} bytes`)

    const targets = recipients.get(session.envelope) ?? []
    const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : ''
    const authentication = await authenticateMessage(
      message,
      { ip: session.remoteAddress, helo: session.hostNameAppearsAs, mailFrom },
      mxHost,
      resolver,
    )
    const rejection = dmarcRejection(authentication)
    if (rejection?.temporary) {
      throw smtpError(451, `4.7.0 The DMARC policy of ${rejection.domain} could not be checked, try again later`)
    }
    if (rejection) {
      logger.info({ session: session.id, domain: rejection.domain }, 'Rejected an email failing DMARC')
      throw smtpError(550, `5.7.1 The DMARC policy of ${rejection.domain} rejects this message`)
    }

    const mime = Buffer.concat([
      Buffer.from(traceHeaders(session, mailFrom, mxHost, authentication.headers)),
      removeForgedResults(message, mxHost),
    ])
    const emailId = emailIdOf(message)
    // Kept before going to Nostr, so the site has the report even while the relays fail.
    for (const domain of abuseDomains.get(session.envelope) ?? []) {
      await repo.addAbuseReport({
        domain,
        emailId,
        mailFrom,
        from: decodedField(message, 'from').slice(0, MAX_LISTED_CHARS),
        subject: decodedField(message, 'subject').slice(0, MAX_LISTED_CHARS),
        message: mime,
      })
      logger.info({ session: session.id, domain, emailId }, 'Kept an abuse report')
    }
    // Only a complaint can reach nobody over Nostr: the copy above is then all there is.
    if (!targets.length) return 'Kept on this server'

    const maxInlineBytes = Math.min(...targets.map((target) => target.writer.maxInlineMimeBytes))
    const email: InboundEmail = {
      mailFrom,
      emailId,
      body: mime.length < maxInlineBytes ? { mime: mime.toString('utf8') } : { blob: await storeBlob(mime, targets) },
    }

    let delivered: boolean[]
    try {
      delivered = await Promise.all(
        targets.map(async ({ writer, pubkey, relays: inboxRelays }) => {
          const wrap = await wrapInboundEmail(email, writer.signer, pubkey)
          const accepted = await relays.publish(inboxRelays, wrap, writer.signer)
          return accepted.length > 0
        }),
      )
    } catch (error) {
      if (!(error instanceof SignerUnavailable || error instanceof SignerRefusal)) throw error
      logger.info({ session: session.id, reason: error.message }, 'The bunker of a domain key did not write an email')
      throw smtpError(451, '4.4.0 The key of the recipient domain is not available, try again later')
    }

    if (delivered.includes(false)) {
      throw smtpError(451, '4.4.0 The recipient relays did not take the message, try again later')
    }

    logger.info(
      {
        session: session.id,
        emailId: email.emailId,
        recipients: targets.length,
        bytes: mime.length,
        ...summarize(authentication),
      },
      'Delivered an email',
    )
    return 'Delivered over Nostr'
  }

  // One blob for every recipient, on the servers of the keys that write the
  // rumors and on the recipients' own: clients look in both.
  async function storeBlob(mime: Buffer, targets: Recipient[]): Promise<EncryptedBlob> {
    const blob = encryptBlob(mime)
    const servers = [
      ...new Set(targets.flatMap((target) => [...target.writer.blossomServers, ...target.blossomServers])),
    ]
    // Any writing key can sign the upload: clients find the blob by its hash.
    const stored = await blobs.upload(servers, blob, targets[0].writer.signer)
    if (!stored.length) throw smtpError(451, '4.4.0 No Blossom server took the message, try again later')

    return blob
  }

  // An unexpected failure is answered as temporary so the sender retries.
  function respond<T>(
    session: SMTPServerSession,
    work: Promise<T>,
    callback: (error?: Error | null, value?: T) => void,
  ): void {
    work.then(
      (value) => callback(null, value),
      (error: SmtpError) => {
        if (error.responseCode) return callback(error)

        logger.error({ session: session.id, error }, 'SMTP command failed')
        callback(smtpError(451, '4.3.0 Temporary failure, try again later'))
      },
    )
  }

  return new SMTPServer({
    name: mxHost,
    banner: 'Nostr Mail',
    size: maxMessageBytes,
    // AUTH is for submission servers, and STARTTLS is offered only with a certificate.
    disabledCommands: tls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    ...tls,
    socketTimeout: SOCKET_TIMEOUT_MS,
    logger: false,
    onRcptTo: (address, session, callback) => respond(session, acceptRecipient(address, session), callback),
    onData: (stream, session, callback) => respond(session, deliver(stream, session), callback),
  })
}

// The whole message is read even past the limit, as the client sends it anyway.
async function readMessage(stream: SMTPServerDataStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    if (!stream.sizeExceeded) chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// RFC 5321 4.4: the server that delivers the message adds Return-Path and a Received line.
// RFC 7208 9.1 and RFC 8601 5: the results of the checks go on top of that Received line.
function traceHeaders(session: SMTPServerSession, mailFrom: string, mxHost: string, results: string): string {
  const date = new Date().toUTCString().replace('GMT', '+0000')
  return (
    `Return-Path: <${mailFrom}>\r\n` +
    results +
    `Received: from ${session.hostNameAppearsAs} (${session.clientHostname} [${session.remoteAddress}])\r\n` +
    `\tby ${mxHost} with ${session.transmissionType} id ${session.id};\r\n` +
    `\t${date}\r\n`
  )
}

function smtpError(responseCode: number, message: string): SmtpError {
  return Object.assign(new Error(message), { responseCode })
}
