import { npubEncode } from 'nostr-tools/nip19'
import { createRumor, createSeal, createWrap, wrapEvent } from 'nostr-tools/nip59'
import { expect, test } from 'vitest'
import { checkAuthor, checkSender, MAX_OUTBOUND_RECIPIENTS, openOutboundWrap, Refusal } from '../src/outbound.js'
import { MemoryDomainRepository, outboundWrap, signer, verifyDomain } from './helpers.js'

async function setup() {
  const repo = new MemoryDomainRepository()
  const owner = signer()
  const alice = signer()
  const domain = await verifyDomain(repo, 'example.com', owner.pubkey)
  const sending = { ...domain, checks: domain.checks && { ...domain.checks, spf: ok, dkim: ok } }
  return { repo, owner, alice, domain: sending, aliceAddress: `${npubEncode(alice.pubkey)}@example.com` }
}

const ok = { status: 'ok' as const, found: [] }

test('a client wrap gives the sender, the envelope and the MIME', async () => {
  const { domain, alice, aliceAddress } = await setup()
  const wrap = outboundWrap(alice, domain.bridgePubkey, {
    rcptTo: ['bob@Remote.Example', 'BOB@remote.example', 'carol+news@other.example'],
  })

  const email = openOutboundWrap(wrap, domain.bridgePrivateKey)

  expect(email.senderPubkey).toBe(alice.pubkey)
  expect(email.mailFrom).toBe(aliceAddress)
  expect(email.recipients).toEqual(['BOB@remote.example', 'carol+news@other.example'])
  expect(email.body).toEqual({ mime: expect.stringContaining('Hello Bob') })
})

test('a large email points to its blob', async () => {
  const { domain, alice } = await setup()
  const sha256 = 'a'.repeat(64)
  const wrap = outboundWrap(alice, domain.bridgePubkey, {
    content: '',
    tags: [
      ['x', sha256],
      ['encryption-algorithm', 'aes-gcm'],
      ['decryption-key', 'a2V5'],
      ['decryption-nonce', 'bm9uY2U='],
    ],
  })

  expect(openOutboundWrap(wrap, domain.bridgePrivateKey).body).toEqual({
    blob: { sha256, key: 'a2V5', nonce: 'bm9uY2U=' },
  })
})

test.each([
  ['an empty email', { content: '' }],
  ['a blob without its key', { content: '', tags: [['x', 'a'.repeat(64)]] }],
  ['no rcpt-to', { rcptTo: [] }],
  ['a recipient without a domain', { rcptTo: ['bob@'] }],
  ['a recipient that breaks the envelope', { rcptTo: ['bob>@remote.example'] }],
  ['a quoted local part', { rcptTo: ['"bob smith"@remote.example'] }],
  [
    'too many recipients',
    { rcptTo: Array.from({ length: MAX_OUTBOUND_RECIPIENTS + 1 }, (_, index) => `r${index}@remote.example`) },
  ],
])('a wrap with %s is refused', async (_, options) => {
  const { domain, alice } = await setup()

  expect(() => openOutboundWrap(outboundWrap(alice, domain.bridgePubkey, options), domain.bridgePrivateKey)).toThrow(
    Refusal,
  )
})

test('a wrap without mail-from, of another kind or for another key is refused', async () => {
  const { domain, alice } = await setup()
  const rcptTo = ['rcpt-to', 'bob@remote.example']
  const wraps = [
    wrapEvent({ kind: 1301, tags: [rcptTo], content: 'Hi' }, alice.sk, domain.bridgePubkey),
    wrapEvent(
      { kind: 14, tags: [['mail-from', 'a@example.com'], rcptTo], content: 'Hi' },
      alice.sk,
      domain.bridgePubkey,
    ),
    outboundWrap(alice, signer().pubkey),
  ]

  for (const wrap of wraps) expect(() => openOutboundWrap(wrap, domain.bridgePrivateKey)).toThrow(Refusal)
})

test('a rumor claiming another author than its seal is refused', async () => {
  const { domain, alice } = await setup()
  const victim = signer()
  const rumor = {
    ...createRumor({ kind: 1301, tags: [['mail-from', 'v@example.com']], content: 'Hi' }, alice.sk),
    pubkey: victim.pubkey,
  }
  const wrap = createWrap(createSeal(rumor, alice.sk, domain.bridgePubkey), domain.bridgePubkey)

  expect(() => openOutboundWrap(wrap, domain.bridgePrivateKey)).toThrow(Refusal)
})

test('a sender writes from its npub address and from the names declared for it', async () => {
  const { repo, owner, domain, alice, aliceAddress } = await setup()
  await repo.putAddress({ domain: 'example.com', localPart: 'alice', pubkey: alice.pubkey, ownerPubkey: owner.pubkey })
  const email = (mailFrom: string) => ({ senderPubkey: alice.pubkey, mailFrom, recipients: [], body: { mime: '' } })

  await expect(checkSender(repo, domain, email(aliceAddress))).resolves.toBeUndefined()
  await expect(checkSender(repo, domain, email('Alice@Example.com'))).resolves.toBeUndefined()
  await expect(checkSender(repo, domain, email(`${npubEncode(owner.pubkey)}@example.com`))).rejects.toThrow(Refusal)
  await expect(checkSender(repo, domain, email('nobody@example.com'))).rejects.toThrow(Refusal)
  await expect(checkSender(repo, domain, email(`${npubEncode(alice.pubkey)}@other.example`))).rejects.toThrow(Refusal)
})

test('a domain sends nothing until its SPF and DKIM records are found', async () => {
  const { repo, domain, alice, aliceAddress } = await setup()
  const pending = {
    ...domain,
    checks: domain.checks && { ...domain.checks, dkim: { status: 'missing' as const, found: [] } },
  }

  await expect(
    checkSender(repo, pending, {
      senderPubkey: alice.pubkey,
      mailFrom: aliceAddress,
      recipients: [],
      body: { mime: '' },
    }),
  ).rejects.toThrow('does not send mail until its SPF and DKIM records are found')
})

test('the From field has to be one address of the sender', async () => {
  const { repo, domain, alice, aliceAddress } = await setup()
  const check = (header: string) =>
    checkAuthor(repo, domain, alice.pubkey, Buffer.from(`${header}\r\nSubject: Hi\r\n\r\nFrom: nobody@example.com\r\n`))

  await expect(check(`From: "Alice A." <${aliceAddress}>`)).resolves.toBeUndefined()
  await expect(check(`from:\r\n Alice\r\n <${aliceAddress}>`)).resolves.toBeUndefined()
  await expect(check('From: Alice <boss@example.com>')).rejects.toThrow('From boss@example.com is not an address')
  await expect(check(`From: ${aliceAddress}, boss@example.com`)).rejects.toThrow(Refusal)
  await expect(check(`From: ${aliceAddress}\r\nFrom: ${aliceAddress}`)).rejects.toThrow(Refusal)
  await expect(check('Sender: x@example.com')).rejects.toThrow(Refusal)
})
