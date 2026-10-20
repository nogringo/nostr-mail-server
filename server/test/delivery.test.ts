import type { AddressInfo } from 'node:net'
import { SMTPServer, type SMTPServerSession } from 'smtp-server'
import { afterEach, expect, test } from 'vitest'
import { createSmtpTransport } from '../src/delivery.js'
import { findExchangers, UndeliverableDomain } from '../src/dns.js'
import type { MxRecord } from '../src/types.js'
import { readFixtureTls } from './helpers.js'

const MESSAGE = Buffer.from('From: alice@example.com\r\nTo: bob@remote.example\r\nSubject: Hi\r\n\r\nHello\r\n')

const servers: SMTPServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))))
})

interface Received {
  session: SMTPServerSession
  message: string
}

// A receiving server that refuses gone@ for good, defers busy@ and refuses blocked@ as a sender.
async function receivingServer() {
  const received: Received[] = []
  const server = new SMTPServer({
    ...(await readFixtureTls('a')),
    disabledCommands: ['AUTH'],
    logger: false,
    onMailFrom: (address, _session, callback) =>
      callback(address.address.startsWith('blocked@') ? smtpError(550, '5.7.1 Sender blocked') : null),
    onRcptTo: (address, _session, callback) => {
      if (address.address.startsWith('gone@')) return callback(smtpError(550, '5.1.1 No such user'))
      if (address.address.startsWith('busy@')) return callback(smtpError(450, '4.2.1 Try again later'))
      callback()
    },
    onData: async (stream, session, callback) => {
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk)
      received.push({ session: structuredClone(session), message: Buffer.concat(chunks).toString() })
      callback()
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const port = (server.server.address() as AddressInfo).port
  return { received, port }
}

function transportTo(port: number, findExchangers = async () => ['127.0.0.1']) {
  return createSmtpTransport({ heloName: 'mx.example.org', findExchangers, port })
}

function smtpError(responseCode: number, message: string) {
  return Object.assign(new Error(message), { responseCode })
}

test('a message goes over STARTTLS with the envelope and the server name', async () => {
  const { received, port } = await receivingServer()

  const results = await transportTo(port).deliver(
    'remote.example',
    'alice@example.com',
    ['bob@remote.example', 'carol@remote.example'],
    MESSAGE,
  )

  expect([...results.values()].map((result) => result.status)).toEqual(['delivered', 'delivered'])
  expect(received).toHaveLength(1)
  const [{ session, message }] = received
  expect(session.secure).toBe(true)
  expect(session.hostNameAppearsAs).toBe('mx.example.org')
  expect(session.envelope.mailFrom ? session.envelope.mailFrom.address : null).toBe('alice@example.com')
  expect(session.envelope.rcptTo.map((recipient) => recipient.address)).toEqual([
    'bob@remote.example',
    'carol@remote.example',
  ])
  expect(message).toBe(MESSAGE.toString())
})

test('each recipient gets the answer its server gave', async () => {
  const { received, port } = await receivingServer()

  const results = await transportTo(port).deliver(
    'remote.example',
    'alice@example.com',
    ['bob@remote.example', 'gone@remote.example', 'busy@remote.example'],
    MESSAGE,
  )

  expect(results.get('bob@remote.example')?.status).toBe('delivered')
  expect(results.get('gone@remote.example')).toEqual({ status: 'failed', response: '550 5.1.1 No such user' })
  expect(results.get('busy@remote.example')).toEqual({ status: 'deferred', response: '450 4.2.1 Try again later' })
  expect(received).toHaveLength(1)
})

test('when every recipient is refused, each keeps its own answer', async () => {
  const { received, port } = await receivingServer()

  const results = await transportTo(port).deliver(
    'remote.example',
    'alice@example.com',
    ['gone@remote.example', 'busy@remote.example'],
    MESSAGE,
  )

  expect(results.get('gone@remote.example')?.status).toBe('failed')
  expect(results.get('busy@remote.example')?.status).toBe('deferred')
  expect(received).toHaveLength(0)
})

test('a refused sender fails every recipient', async () => {
  const { port } = await receivingServer()

  const results = await transportTo(port).deliver(
    'remote.example',
    'blocked@example.com',
    ['bob@remote.example'],
    MESSAGE,
  )

  expect(results.get('bob@remote.example')).toEqual({ status: 'failed', response: '550 5.7.1 Sender blocked' })
})

test('an exchanger that refuses connections gives way to the next one', async () => {
  const { received, port } = await receivingServer()
  const transport = transportTo(port, async () => ['::1', '127.0.0.1'])

  const results = await transport.deliver('remote.example', 'alice@example.com', ['bob@remote.example'], MESSAGE)

  expect(results.get('bob@remote.example')?.status).toBe('delivered')
  expect(received).toHaveLength(1)
})

test('a domain that takes no mail fails, a lookup that failed is deferred', async () => {
  const { port } = await receivingServer()
  const undeliverable = transportTo(port, async () => {
    throw new UndeliverableDomain('remote.example does not exist')
  })
  const failing = transportTo(port, async () => {
    throw new Error('queryMx ESERVFAIL remote.example')
  })

  const deliver = (transport: ReturnType<typeof transportTo>) =>
    transport.deliver('remote.example', 'alice@example.com', ['bob@remote.example'], MESSAGE)

  expect((await deliver(undeliverable)).get('bob@remote.example')).toEqual({
    status: 'failed',
    response: 'remote.example does not exist',
  })
  expect((await deliver(failing)).get('bob@remote.example')?.status).toBe('deferred')
})

const resolving = (records: MxRecord[] | NodeJS.ErrnoException) => async (): Promise<MxRecord[]> => {
  if (records instanceof Error) throw records
  return records
}

const dnsError = (code: string) => Object.assign(new Error(`queryMx ${code}`), { code })

test('exchangers come in order of preference, the domain itself without MX', async () => {
  const records = [
    { exchange: 'backup.remote.example.', priority: 20 },
    { exchange: 'MX.remote.example', priority: 10 },
  ]

  expect(await findExchangers('remote.example', resolving(records))).toEqual([
    'mx.remote.example',
    'backup.remote.example',
  ])
  expect(await findExchangers('remote.example', resolving(dnsError('ENODATA')))).toEqual(['remote.example'])
})

test('a missing domain or a null MX cannot receive mail, other lookup errors are thrown as they are', async () => {
  await expect(findExchangers('remote.example', resolving(dnsError('ENOTFOUND')))).rejects.toThrow(UndeliverableDomain)
  await expect(findExchangers('remote.example', resolving([{ exchange: '', priority: 0 }]))).rejects.toThrow(
    'remote.example does not accept mail',
  )
  await expect(findExchangers('remote.example', resolving(dnsError('ESERVFAIL')))).rejects.toThrow('ESERVFAIL')
})
