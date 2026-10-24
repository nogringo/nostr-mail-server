import { createHash } from 'node:crypto'
import { npubEncode } from 'nostr-tools/nip19'
import type { NostrEvent } from 'nostr-tools/pure'
import { expect, test, vi } from 'vitest'
import { encryptBlob } from '../src/blossom.js'
import { DomainSigners } from '../src/bunker.js'
import type { DeliveryResult, MailTransport } from '../src/delivery.js'
import { Outbox } from '../src/outbox.js'
import { SignerUnavailable } from '../src/signer.js'
import {
  claim,
  FakeBlobStore,
  FakeBunker,
  FakeRelayNetwork,
  MemoryDomainRepository,
  newBridgeKey,
  outboundWrap,
  sendingDomain,
  settingsStore,
  signer,
  verifyDomain,
} from './helpers.js'

// A relay the domain keys announced before the server's own.
const DOMAIN_RELAY = 'wss://relay.example.org/'
const DOMAIN_SERVER = 'https://blossom.example.org'
const DAY_MS = 24 * 3600_000

interface Sent {
  domain: string
  mailFrom: string
  recipients: string[]
  message: string
}

class FakeTransport implements MailTransport {
  readonly sent: Sent[] = []
  readonly answers = new Map<string, DeliveryResult>()

  async deliver(domain: string, mailFrom: string, recipients: string[], message: Buffer) {
    this.sent.push({ domain, mailFrom, recipients, message: message.toString() })
    return new Map(
      recipients.map((recipient) => [
        recipient,
        this.answers.get(recipient) ?? { status: 'delivered' as const, response: '250 2.0.0 OK' },
      ]),
    )
  }
}

async function setup(bunker = new FakeBunker()) {
  const repo = new MemoryDomainRepository()
  const network = new FakeRelayNetwork()
  const blobs = new FakeBlobStore()
  const transport = new FakeTransport()
  const logs: string[] = []
  const logger = { info: (_: object, message: string) => logs.push(message), error: () => {} }
  const settings = settingsStore(repo, {
    blossomServers: [DOMAIN_SERVER],
    retiredDomainRelays: { [DOMAIN_RELAY]: new Date(Date.now() + 7 * DAY_MS).toISOString() },
  })
  const outbox = new Outbox(
    repo,
    network,
    blobs,
    transport,
    settings,
    logger,
    new DomainSigners({ open: bunker.open, timeoutMs: 50 }),
  )
  const domain = await sendingDomain(repo, 'example.com', signer().pubkey)
  const alice = signer()

  // Receives the wrap as a subscription would, then delivers what is due.
  const receive = async (wrap: NostrEvent) => {
    await outbox.receive(wrap, domain.bridgePubkey)
    await outbox.deliverDue()
  }

  return { repo, network, blobs, transport, logs, outbox, domain, alice, receive, settings }
}

test('each verified domain key gets its own subscription, closed once the domain goes', async () => {
  const { repo, network, outbox, domain } = await setup()
  const other = await verifyDomain(repo, 'other.example', signer().pubkey)
  await repo.createDomain(claim('pending.example', signer().pubkey))

  await outbox.syncSubscriptions()

  const open = network.open()
  expect(open.map((subscription) => subscription.filter['#p'])).toEqual([[domain.bridgePubkey], [other.bridgePubkey]])
  const [first] = open
  expect(first.relays).toEqual([DOMAIN_RELAY])
  expect(first.filter.kinds).toEqual([1059])
  expect(first.filter.since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 2 * 24 * 3600)
  expect(first.auth.pubkey).toBe(domain.bridgePubkey)

  await repo.deleteDomain('other.example', other.pubkey)
  await outbox.syncSubscriptions()

  expect(network.open().map((subscription) => subscription.filter['#p'])).toEqual([[domain.bridgePubkey]])
  await outbox.stop()
  expect(network.open()).toEqual([])
})

test('the relays announced before the server relay are listened to for a week, then none', async () => {
  const { network, outbox } = await setup()
  await outbox.syncSubscriptions()
  expect(network.open().map((subscription) => subscription.relays)).toEqual([[DOMAIN_RELAY]])

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 8 * DAY_MS)
  try {
    await outbox.syncSubscriptions()
  } finally {
    vi.useRealTimers()
  }

  expect(network.open()).toEqual([])
  await outbox.stop()
})

test('receive answers why a wrap is refused, the same to a copy that comes meanwhile, and nothing after', async () => {
  const { outbox, domain, alice } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey, { mailFrom: 'bob@example.com' })

  const answers = await Promise.all([
    outbox.receive(wrap, domain.bridgePubkey),
    outbox.receive(wrap, domain.bridgePubkey),
  ])

  expect(answers).toEqual(Array(2).fill('bob@example.com is not an address of the sender'))
  expect(await outbox.receive(wrap, domain.bridgePubkey)).toBeNull()
  expect(await outbox.receive(outboundWrap(alice, domain.bridgePubkey), domain.bridgePubkey)).toBeNull()
})

test('a replaced domain key is listened to instead of the old one', async () => {
  const { repo, network, outbox, domain } = await setup()
  await outbox.syncSubscriptions()
  const replacement = newBridgeKey()

  await repo.replaceBridgeKey('example.com', domain.pubkey, replacement)
  await outbox.syncSubscriptions()

  const open = network.open()
  expect(open.map((subscription) => subscription.filter['#p'])).toEqual([[replacement.bridgePubkey]])
  expect(open[0].auth.pubkey).toBe(replacement.bridgePubkey)
  await outbox.stop()
})

test('a domain key in a bunker listens, opens and sends through it', async () => {
  const bunker = new FakeBunker()
  const { repo, network, transport, outbox, alice, domain } = await setup(bunker)
  await repo.replaceBridgeKey('example.com', domain.pubkey, bunker.bridgeKey())
  const receive = async (wrap: NostrEvent) => {
    await outbox.receive(wrap, bunker.key.pubkey)
    await outbox.deliverDue()
  }

  await outbox.syncSubscriptions()
  await receive(outboundWrap(alice, bunker.key.pubkey))
  bunker.silent = true
  const waiting = outboundWrap(alice, bunker.key.pubkey)
  await expect(receive(waiting)).rejects.toThrow(SignerUnavailable)
  bunker.silent = false
  await receive(waiting)
  bunker.refusing = 'unauthorized'
  const refused = outboundWrap(alice, bunker.key.pubkey)
  await receive(refused)

  expect(network.open().map((subscription) => subscription.auth.pubkey)).toEqual([bunker.key.pubkey])
  expect(transport.sent).toHaveLength(2)
  expect(repo.outbound.get(refused.id)?.refusal).toMatch(/refused nip44_decrypt/)
  await outbox.stop()
})

test('mail queued for a domain key in a bunker waits while the bunker is away', async () => {
  const bunker = new FakeBunker()
  const { repo, transport, outbox, alice, domain } = await setup(bunker)
  await repo.replaceBridgeKey('example.com', domain.pubkey, bunker.bridgeKey())
  transport.answers.set('bob@remote.example', { status: 'deferred', response: '451 4.7.1 Greylisted' })
  const wrap = outboundWrap(alice, bunker.key.pubkey)
  await outbox.receive(wrap, bunker.key.pubkey)
  await outbox.deliverDue()

  bunker.silent = true
  transport.answers.delete('bob@remote.example')
  const bob = repo.outbound.get(wrap.id)?.recipients.get('bob@remote.example')
  if (bob) bob.nextAttemptAt = new Date(Date.now() - 1000)
  await outbox.deliverDue()

  expect(transport.sent).toHaveLength(1)
  expect(bob).toMatchObject({ status: 'pending', attempts: 2, response: expect.stringMatching(/did not answer/) })
  await outbox.stop()
})

test('a suspended domain stops listening and its queued mail fails', async () => {
  const { repo, network, transport, outbox, alice, domain, receive } = await setup()
  transport.answers.set('bob@remote.example', { status: 'deferred', response: '451 4.7.1 Greylisted' })
  const wrap = outboundWrap(alice, domain.bridgePubkey)
  await outbox.syncSubscriptions()
  await receive(wrap)

  await repo.suspendDomain('example.com')
  await outbox.syncSubscriptions()
  const bob = repo.outbound.get(wrap.id)?.recipients.get('bob@remote.example')
  if (bob) bob.nextAttemptAt = new Date(Date.now() - 1000)
  await outbox.deliverDue()

  expect(network.open()).toEqual([])
  expect(transport.sent).toHaveLength(1)
  expect(bob).toMatchObject({ status: 'failed', attempts: 2 })
  await outbox.stop()
})

test('a wrap from an address of the sender goes out DKIM signed, one transaction per recipient domain', async () => {
  const { repo, transport, alice, domain, receive } = await setup()
  const mailFrom = `${npubEncode(alice.pubkey)}@example.com`
  const wrap = outboundWrap(alice, domain.bridgePubkey, {
    rcptTo: ['bob@remote.example', 'carol@remote.example', 'dave@other.example'],
  })

  await receive(wrap)

  expect(transport.sent.map(({ domain, recipients }) => [domain, recipients])).toEqual([
    ['remote.example', ['bob@remote.example', 'carol@remote.example']],
    ['other.example', ['dave@other.example']],
  ])
  const [{ mailFrom: envelopeFrom, message }] = transport.sent
  expect(envelopeFrom).toBe(mailFrom)
  expect(message).toMatch(/^DKIM-Signature: [\s\S]*\bd=example\.com;[\s\S]*\bs=nostrmail;/)
  expect(message).toContain(
    `\r\nFrom: Alice <${mailFrom}>\r\nTo: bob@remote.example\r\nSubject: Hi\r\n\r\nHello Bob\r\n`,
  )

  const stored = repo.outbound.get(wrap.id)
  expect(stored?.wrap).toBeNull()
  expect([...(stored?.recipients.values() ?? [])].map(({ status, attempts }) => [status, attempts])).toEqual([
    ['delivered', 1],
    ['delivered', 1],
    ['delivered', 1],
  ])
})

test('a domain sends to its daily quota of recipients, and refuses the mail that would go over', async () => {
  const { repo, transport, alice, domain, receive, settings } = await setup()
  await settings.update({ quotas: { recipientsPerDay: 3 } })

  await receive(outboundWrap(alice, domain.bridgePubkey, { rcptTo: ['a@remote.example', 'b@remote.example'] }))
  const over = outboundWrap(alice, domain.bridgePubkey, { rcptTo: ['c@remote.example', 'd@remote.example'] })
  await receive(over)
  await receive(outboundWrap(alice, domain.bridgePubkey, { rcptTo: ['c@remote.example'] }))

  expect(transport.sent.flatMap((sent) => sent.recipients)).toEqual([
    'a@remote.example',
    'b@remote.example',
    'c@remote.example',
  ])
  expect(repo.outbound.get(over.id)?.refusal).toBe('example.com sends mail to 3 recipients a day at most')
})

test('a named address declared for the sender can send', async () => {
  const { repo, transport, alice, domain, receive } = await setup()
  await repo.putAddress({
    domain: 'example.com',
    localPart: 'alice',
    pubkeys: [alice.pubkey],
    ownerPubkey: domain.pubkey,
  })

  await receive(
    outboundWrap(alice, domain.bridgePubkey, {
      mailFrom: 'alice@example.com',
      content: 'From: alice@example.com\r\nSubject: Hi\r\n\r\nHello\r\n',
    }),
  )

  expect(transport.sent).toHaveLength(1)
})

test('a wrap from someone else than the owner of mail-from is refused once and for all', async () => {
  const { repo, transport, logs, alice, domain, receive } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey, { mailFrom: `${npubEncode(domain.pubkey)}@example.com` })

  await receive(wrap)
  await receive(wrap)

  expect(transport.sent).toEqual([])
  expect(repo.outbound.get(wrap.id)?.refusal).toMatch(/is not an address of the sender$/)
  expect(logs).toEqual(['Refused an email'])
})

test('a domain without SPF and DKIM refuses to send', async () => {
  const { repo, network, blobs, transport, alice } = await setup()
  const domain = await verifyDomain(repo, 'quiet.example', signer().pubkey)
  const outbox = new Outbox(repo, network, blobs, transport, settingsStore(repo), { info() {}, error() {} })
  const wrap = outboundWrap(alice, domain.bridgePubkey, { mailFrom: `${npubEncode(alice.pubkey)}@quiet.example` })

  await outbox.receive(wrap, domain.bridgePubkey)
  await outbox.deliverDue()

  expect(transport.sent).toEqual([])
  expect(repo.outbound.get(wrap.id)?.refusal).toContain('does not send mail until its SPF and DKIM records are found')
})

test('an email whose From is not the sender fails without being sent', async () => {
  const { repo, transport, alice, domain, receive } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey, { content: 'From: ceo@example.com\r\n\r\nPay this\r\n' })

  await receive(wrap)

  expect(transport.sent).toEqual([])
  const [recipient] = repo.outbound.get(wrap.id)?.recipients.values() ?? []
  expect(recipient).toMatchObject({
    status: 'failed',
    response: 'From ceo@example.com is not an address of the sender',
  })
})

test('a wrap seen again, even by a new process, is not sent twice', async () => {
  const { repo, network, blobs, transport, alice, domain, outbox, receive } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey)
  await receive(wrap)

  await outbox.receive(wrap, domain.bridgePubkey)
  const restarted = new Outbox(repo, network, blobs, transport, settingsStore(repo), { info() {}, error() {} })
  await restarted.receive(wrap, domain.bridgePubkey)
  await restarted.deliverDue()

  expect(transport.sent).toHaveLength(1)
})

test('a deferred recipient is tried again later, alone', async () => {
  const { repo, transport, alice, domain, outbox, receive } = await setup()
  transport.answers.set('busy@remote.example', { status: 'deferred', response: '451 4.7.1 Greylisted' })
  const wrap = outboundWrap(alice, domain.bridgePubkey, { rcptTo: ['bob@remote.example', 'busy@remote.example'] })

  await receive(wrap)
  const busy = repo.outbound.get(wrap.id)?.recipients.get('busy@remote.example')
  expect(busy).toMatchObject({ status: 'pending', attempts: 1, response: '451 4.7.1 Greylisted' })
  expect(busy?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)

  await outbox.deliverDue()
  expect(transport.sent).toHaveLength(1)

  transport.answers.clear()
  if (busy) busy.nextAttemptAt = new Date(Date.now() - 1000)
  await outbox.deliverDue()

  expect(transport.sent.map(({ recipients }) => recipients)).toEqual([
    ['bob@remote.example', 'busy@remote.example'],
    ['busy@remote.example'],
  ])
  expect(repo.outbound.get(wrap.id)?.wrap).toBeNull()
})

test('a recipient still deferred after four days fails', async () => {
  const { repo, transport, alice, domain, outbox, receive } = await setup()
  transport.answers.set('bob@remote.example', { status: 'deferred', response: 'connect ECONNREFUSED' })
  const wrap = outboundWrap(alice, domain.bridgePubkey)
  await receive(wrap)
  const stored = repo.outbound.get(wrap.id)
  const bob = stored?.recipients.get('bob@remote.example')
  if (stored && bob) {
    stored.receivedAt = new Date(Date.now() - 5 * 24 * 3600_000).toISOString()
    bob.nextAttemptAt = new Date(Date.now() - 1000)
  }

  await outbox.deliverDue()

  expect(bob).toMatchObject({
    status: 'failed',
    response: 'Gave up after 4 days: connect ECONNREFUSED',
  })
})

test('a large email is read on the server, or on the domain servers or the sender ones, and its blob then goes', async () => {
  const { repo, network, blobs, transport, outbox, alice, domain, receive } = await setup()
  const mailFrom = `${npubEncode(alice.pubkey)}@example.com`
  const blobWrap = (mime: string) => {
    const blob = encryptBlob(Buffer.from(mime))
    const wrap = outboundWrap(alice, domain.bridgePubkey, {
      content: '',
      tags: [
        ['x', blob.sha256],
        ['encryption-algorithm', 'aes-gcm'],
        ['decryption-key', blob.key],
        ['decryption-nonce', blob.nonce],
      ],
    })
    return { blob, wrap }
  }

  const onServer = blobWrap(`From: ${mailFrom}\nSubject: Big\n\nOn the server\n`)
  await repo.addBlob(onServer.blob.sha256, onServer.blob.bytes, alice.pubkey)
  await receive(onServer.wrap)
  expect(blobs.downloads).toEqual([])

  const onDomain = blobWrap(`From: ${mailFrom}\nSubject: Big\n\nOn the domain server\n`)
  blobs.store(DOMAIN_SERVER, onDomain.blob)
  await receive(onDomain.wrap)

  const onSender = blobWrap(`From: ${mailFrom}\nSubject: Big\n\nOn the sender server\n`)
  blobs.store('https://cdn.alice.example', onSender.blob)
  network.blossomServers.set(alice.pubkey, ['https://cdn.alice.example', DOMAIN_SERVER])
  await receive(onSender.wrap)

  expect(transport.sent.map(({ message }) => message.split('\r\n\r\n')[1])).toEqual([
    'On the server\r\n',
    'On the domain server\r\n',
    'On the sender server\r\n',
  ])
  expect(blobs.downloads.at(-1)).toEqual(['https://cdn.alice.example'])

  await outbox.tick()
  expect(repo.blobs.has(onServer.blob.sha256)).toBe(false)
})

test('a public email in a blob in the clear goes out as it is', async () => {
  const { repo, transport, alice, domain, receive } = await setup()
  const mime = Buffer.from(`From: ${npubEncode(alice.pubkey)}@example.com\nSubject: Public\n\nFor everyone\n`)
  const sha256 = createHash('sha256').update(mime).digest('hex')
  await repo.addBlob(sha256, mime, alice.pubkey)

  await receive(outboundWrap(alice, domain.bridgePubkey, { content: '', tags: [['x', sha256]] }))

  expect(transport.sent.map(({ message }) => message.split('\r\n\r\n')[1])).toEqual(['For everyone\r\n'])
})

test('a blob found nowhere waits for a retry', async () => {
  const { repo, transport, alice, domain, receive } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey, {
    content: '',
    tags: [
      ['x', 'a'.repeat(64)],
      ['encryption-algorithm', 'aes-gcm'],
      ['decryption-key', 'a2V5'],
      ['decryption-nonce', 'bm9uY2U='],
    ],
  })

  await receive(wrap)

  expect(transport.sent).toEqual([])
  expect(repo.outbound.get(wrap.id)?.recipients.get('bob@remote.example')).toMatchObject({
    status: 'pending',
    response: 'The email blob is on no Blossom server',
  })
})

test('a wrap dated in the future or more than six days back is ignored', async () => {
  const { repo, alice, domain, receive } = await setup()
  const now = Math.floor(Date.now() / 1000)
  const future = { ...outboundWrap(alice, domain.bridgePubkey), created_at: now + 7200 }
  const stale = { ...outboundWrap(alice, domain.bridgePubkey), created_at: now - 7 * 24 * 3600 }
  const late = { ...outboundWrap(alice, domain.bridgePubkey), created_at: now - 5 * 24 * 3600 }

  for (const wrap of [future, stale, late]) await receive(wrap)

  expect([...repo.outbound.keys()]).toEqual([late.id])
})

test('messages that wait for nothing are pruned after a week', async () => {
  const { repo, alice, domain, outbox, receive } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey)
  await receive(wrap)
  const stored = repo.outbound.get(wrap.id)
  if (stored) stored.receivedAt = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()

  await outbox.tick()
  await outbox.stop()

  expect(repo.outbound.size).toBe(0)
})
