import type { DNSResolver } from 'mailauth'
import { hexToBytes } from 'nostr-tools/utils'
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerDataStream,
  type SMTPServerEnvelope,
  type SMTPServerSession,
} from 'smtp-server'
import { findAddressPubkey, parseEmailAddress } from './address.js'
import { authenticateMessage, dmarcRejection, removeForgedResults, summarize } from './authentication.js'
import { type BlobStore, type EncryptedBlob, encryptBlob } from './blossom.js'
import { emailIdOf, type InboundEmail, MAX_INLINE_MIME_BYTES, wrapInboundEmail } from './inbound.js'
import type { Inbox, RelayNetwork } from './relays.js'
import type { TlsCredentials } from './tls.js'
import type { AppConfig, Domain, DomainRepository } from './types.js'

const MAX_RECIPIENTS = 50
// RFC 5321 4.5.3.2.7: a server waits 5 minutes for the next command. The timer
// also runs while a message is delivered after DATA, uploads included.
const SOCKET_TIMEOUT_MS = 5 * 60 * 1000

interface Recipient extends Inbox {
  domain: Domain
  pubkey: string
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
  { mxHost, maxMessageBytes }: Pick<AppConfig, 'mxHost' | 'maxMessageBytes'>,
  { logger = silent, tls }: { logger?: SmtpLogger; tls?: TlsCredentials } = {},
): SMTPServer {
  // Keyed by envelope, which the server replaces for every transaction.
  const recipients = new WeakMap<SMTPServerEnvelope, Recipient[]>()

  async function acceptRecipient(address: SMTPServerAddress, session: SMTPServerSession): Promise<void> {
    const accepted = recipients.get(session.envelope) ?? []
    if (accepted.length >= MAX_RECIPIENTS) throw smtpError(452, '4.5.3 Too many recipients')

    const parsed = parseEmailAddress(address.address)
    const domain = parsed ? await repo.findVerifiedDomain(parsed.domain) : null
    const pubkey = parsed && domain ? await findAddressPubkey(repo, domain.domain, parsed.localPart) : null
    if (!domain || !pubkey) throw smtpError(550, '5.1.1 No such user here')
    if (accepted.some((recipient) => recipient.pubkey === pubkey)) return

    const inbox = await relays.findInbox(pubkey)
    if (!inbox.dmRelays.length) throw smtpError(450, '4.2.0 The recipient has no Nostr DM relays yet')

    accepted.push({ domain, pubkey, ...inbox })
    recipients.set(session.envelope, accepted)
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
    const email: InboundEmail = {
      mailFrom,
      emailId: emailIdOf(message),
      body:
        mime.length < MAX_INLINE_MIME_BYTES
          ? { mime: mime.toString('utf8') }
          : { blob: await storeBlob(mime, targets) },
    }

    const delivered = await Promise.all(
      targets.map(async ({ domain, pubkey, dmRelays }) => {
        const wrap = wrapInboundEmail(email, domain.bridgePrivateKey, pubkey)
        const accepted = await relays.publish(dmRelays, wrap, hexToBytes(domain.bridgePrivateKey))
        return accepted.length > 0
      }),
    )

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

  // One blob for every recipient, on the servers of the domain keys that write
  // the rumors and on the recipients' own: clients look in both.
  async function storeBlob(mime: Buffer, targets: Recipient[]): Promise<EncryptedBlob> {
    const blob = encryptBlob(mime)
    const servers = [
      ...new Set(targets.flatMap((target) => [...target.domain.blossomServers, ...target.blossomServers])),
    ]
    // Any domain key can sign the upload: clients find the blob by its hash.
    const stored = await blobs.upload(servers, blob, hexToBytes(targets[0].domain.bridgePrivateKey))
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
