import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { type AddressInfo, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as connectTls } from 'node:tls'
import { afterEach, expect, test } from 'vitest'
import { createSmtpServer } from '../src/smtp.js'
import { readTls, reloadTls } from '../src/tls.js'
import { FakeBlobStore, FakeRelayNetwork, fixtureTlsFiles, MemoryDomainRepository, replyReader } from './helpers.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// A server whose certificate files can be replaced, as a renewal does.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'nostr-mail-tls-'))
  const files = { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }
  const install = async (cert: 'a' | 'b', key: 'a' | 'b' = cert) => {
    await copyFile(fixtureTlsFiles(cert).certFile, files.certFile)
    await copyFile(fixtureTlsFiles(key).keyFile, files.keyFile)
  }
  await install('a')

  const loaded = await readTls(files)
  const server = createSmtpServer(
    new MemoryDomainRepository(),
    new FakeRelayNetwork(),
    new FakeBlobStore(),
    { mxHost: 'mx.example.org', maxMessageBytes: 1024 },
    { tls: loaded },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as AddressInfo).port
  const errors: string[] = []
  const reloader = reloadTls(server, files, loaded, { info() {}, error: (_details, message) => errors.push(message) })
  cleanups.push(async () => {
    reloader.stop()
    await new Promise<void>((resolve) => server.close(resolve))
    await rm(dir, { recursive: true })
  })

  return { port, install, reload: reloader.reload, errors }
}

async function fingerprint(name: 'a' | 'b'): Promise<string> {
  return new X509Certificate(await readFile(fixtureTlsFiles(name).certFile)).fingerprint256
}

// The fingerprint of the certificate the server presents after STARTTLS.
async function presented(port: number): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  const reply = replyReader(socket)
  await reply()
  socket.write('EHLO client.example\r\n')
  await reply()
  socket.write('STARTTLS\r\n')
  expect(await reply()).toMatch(/^220 /)

  socket.removeAllListeners('data')
  const secure = connectTls({ socket, servername: 'mx.example.org', rejectUnauthorized: false })
  await once(secure, 'secureConnect')
  const certificate = secure.getPeerCertificate().fingerprint256
  secure.destroy()
  return certificate
}

test('a renewed certificate applies to the next STARTTLS', async () => {
  const { port, install, reload, errors } = await setup()
  expect(await presented(port)).toBe(await fingerprint('a'))

  await install('b')
  await reload()

  expect(await presented(port)).toBe(await fingerprint('b'))
  expect(errors).toEqual([])
})

test('a certificate and key that do not match leave the previous pair in place', async () => {
  const { port, install, reload, errors } = await setup()

  await install('b', 'a')
  await reload()

  expect(errors).toHaveLength(1)
  expect(await presented(port)).toBe(await fingerprint('a'))
})
