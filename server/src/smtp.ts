import { hexToBytes } from 'nostr-tools/utils'
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerDataStream,
  type SMTPServerEnvelope,
  type SMTPServerSession,
} from 'smtp-server'
import { findAddressPubkey, parseEmailAddress } from './address.js'
import { emailIdOf, MAX_INLINE_MIME_BYTES, wrapInboundEmail } from './inbound.js'
import type { RelayNetwork } from './relays.js'
import type { AppConfig, Domain, DomainRepository } from './types.js'

const MAX_RECIPIENTS = 50

interface Recipient {
  domain: Domain
  pubkey: string
  relays: string[]
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
  { mxHost }: Pick<AppConfig, 'mxHost'>,
  { logger = silent }: { logger?: SmtpLogger } = {},
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

    const dmRelays = await relays.findDmRelays(pubkey)
    if (!dmRelays.length) throw smtpError(450, '4.2.0 The recipient has no Nostr DM relays yet')

    accepted.push({ domain, pubkey, relays: dmRelays })
    recipients.set(session.envelope, accepted)
  }

  async function deliver(stream: SMTPServerDataStream, session: SMTPServerSession): Promise<string> {
    const message = await readMessage(stream)
    if (stream.sizeExceeded) {
      throw smtpError(552, `5.3.4 Messages are limited to ${MAX_INLINE_MIME_BYTES} bytes for now`)
    }

    const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : ''
    const email = {
      mime: traceHeaders(session, mailFrom, mxHost) + message.toString('utf8'),
      mailFrom,
      emailId: emailIdOf(message),
    }

    const targets = recipients.get(session.envelope) ?? []
    const delivered = await Promise.all(
      targets.map(async ({ domain, pubkey, relays: dmRelays }) => {
        const wrap = wrapInboundEmail(email, domain.bridgePrivateKey, pubkey)
        const accepted = await relays.publish(dmRelays, wrap, hexToBytes(domain.bridgePrivateKey))
        return accepted.length > 0
      }),
    )

    if (delivered.includes(false)) {
      throw smtpError(451, '4.4.0 The recipient relays did not take the message, try again later')
    }

    logger.info({ session: session.id, emailId: email.emailId, recipients: targets.length }, 'Delivered an email')
    return 'Delivered over Nostr'
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
    size: MAX_INLINE_MIME_BYTES,
    // AUTH is for submission servers; STARTTLS needs the certificate the deployment provides.
    disabledCommands: ['AUTH', 'STARTTLS'],
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
function traceHeaders(session: SMTPServerSession, mailFrom: string, mxHost: string): string {
  const date = new Date().toUTCString().replace('GMT', '+0000')
  return (
    `Return-Path: <${mailFrom}>\r\n` +
    `Received: from ${session.hostNameAppearsAs} (${session.clientHostname} [${session.remoteAddress}])\r\n` +
    `\tby ${mxHost} with ${session.transmissionType} id ${session.id};\r\n` +
    `\t${date}\r\n`
  )
}

function smtpError(responseCode: number, message: string): SmtpError {
  return Object.assign(new Error(message), { responseCode })
}
