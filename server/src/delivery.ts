import nodemailer, { type NodemailerError } from 'nodemailer'
import { UndeliverableDomain } from './dns.js'

const CONNECTION_TIMEOUT_MS = 30_000

export interface DeliveryResult {
  // Deferred means the recipient's server may take it later.
  status: 'delivered' | 'deferred' | 'failed'
  response: string
}

export interface MailTransport {
  // Sends one message to recipients of the same domain, with a result for each.
  deliver(domain: string, mailFrom: string, recipients: string[], message: Buffer): Promise<Map<string, DeliveryResult>>
}

interface TransportOptions {
  // The EHLO name, which the address of this server should resolve back to.
  heloName: string
  findExchangers: (domain: string) => Promise<string[]>
  port?: number
}

// Delivers straight to the recipient domain's MX hosts, trying the next one
// while a host cannot be reached or answers with a temporary error.
export function createSmtpTransport({ heloName, findExchangers, port = 25 }: TransportOptions): MailTransport {
  async function send(host: string, mailFrom: string, recipients: string[], message: Buffer) {
    const transport = nodemailer.createTransport({
      host,
      port,
      name: heloName,
      // Opportunistic TLS, as between mail servers: their certificates are rarely checkable.
      opportunisticTLS: true,
      tls: { rejectUnauthorized: false },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    })
    try {
      return await transport.sendMail({ envelope: { from: mailFrom, to: recipients }, raw: message })
    } finally {
      transport.close()
    }
  }

  return {
    async deliver(domain, mailFrom, recipients, message) {
      let hosts: string[]
      try {
        hosts = await findExchangers(domain)
      } catch (error) {
        if (error instanceof UndeliverableDomain) return sameFor(recipients, failed(error.message))
        return sameFor(recipients, deferred(`The MX lookup of ${domain} failed: ${(error as Error).message}`))
      }

      let last = deferred(`No mail server of ${domain} could be reached`)
      for (const host of hosts) {
        try {
          const info = await send(host, mailFrom, recipients, message)
          return resultsFor(recipients, info.rejectedErrors ?? [], delivered(info.response))
        } catch (error) {
          const { rejectedErrors } = error as NodemailerError
          if (rejectedErrors) return resultsFor(recipients, rejectedErrors, failed('Refused'))

          last = resultOf(error as NodemailerError)
          if (last.status === 'failed') break
        }
      }
      return sameFor(recipients, last)
    },
  }
}

function resultsFor(
  recipients: string[],
  rejected: NodemailerError[],
  otherwise: DeliveryResult,
): Map<string, DeliveryResult> {
  const results = sameFor(recipients, otherwise)
  for (const error of rejected) {
    const recipient = recipients.find((address) => address.toLowerCase() === error.recipient?.toLowerCase())
    if (recipient) results.set(recipient, resultOf(error))
  }
  return results
}

function sameFor(recipients: string[], result: DeliveryResult): Map<string, DeliveryResult> {
  return new Map(recipients.map((recipient) => [recipient, result]))
}

// Only a 5xx reply is permanent: a connection that failed may work next time.
function resultOf(error: NodemailerError): DeliveryResult {
  const response = error.response ?? error.message
  return error.responseCode && error.responseCode >= 500 ? failed(response) : deferred(response)
}

const delivered = (response: string): DeliveryResult => ({ status: 'delivered', response })
const deferred = (response: string): DeliveryResult => ({ status: 'deferred', response })
const failed = (response: string): DeliveryResult => ({ status: 'failed', response })
