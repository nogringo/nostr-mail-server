import { readFile } from 'node:fs/promises'
import { createSecureContext } from 'node:tls'
import type { SMTPServer } from 'smtp-server'
import type { SmtpLogger } from './smtp.js'
import type { TlsFiles } from './types.js'

export interface TlsCredentials {
  cert: Buffer
  key: Buffer
}

const RELOAD_INTERVAL_MS = 60 * 60 * 1000

export async function readTls({ certFile, keyFile }: TlsFiles): Promise<TlsCredentials> {
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)])
  return { cert, key }
}

// The certificate is renewed in place, so the files are read again every hour
// and a new pair applies from the next STARTTLS.
export function reloadTls(
  server: SMTPServer,
  files: TlsFiles,
  loaded: TlsCredentials,
  logger: SmtpLogger,
  intervalMs = RELOAD_INTERVAL_MS,
) {
  let current = loaded

  async function reload(): Promise<void> {
    try {
      const next = await readTls(files)
      if (next.cert.equals(current.cert) && next.key.equals(current.key)) return

      // updateSecureContext() leaves the server without a context when the pair
      // is invalid, as when a renewal is read between its two files.
      createSecureContext(next)
      server.updateSecureContext(next)
      current = next
      logger.info({}, 'Reloaded the TLS certificate')
    } catch (error) {
      logger.error({ error }, 'Could not reload the TLS certificate, the previous one stays')
    }
  }

  const timer = setInterval(reload, intervalMs).unref()
  return { reload, stop: () => clearInterval(timer) }
}
