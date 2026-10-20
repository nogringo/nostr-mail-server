import { expect, test } from 'vitest'
import { buildApp } from '../src/app.js'
import type { DomainRepository } from '../src/types.js'
import {
  apiConfig,
  FakeDns,
  FakeRelayNetwork,
  MemoryDomainRepository,
  request,
  signer,
  verifyDomain,
} from './helpers.js'

const MESSAGE = Buffer.from('From: spam@sender.example\r\nSubject: Spam\r\n\r\nHello\r\n')

function setup() {
  const repo = new MemoryDomainRepository()
  const admin = signer()
  const app = buildApp(repo, { ...apiConfig, adminPubkeys: [admin.pubkey] }, new FakeDns(), new FakeRelayNetwork())
  return { repo, app, admin }
}

async function report(repo: DomainRepository, domain: string, emailId = domain) {
  await repo.addAbuseReport({
    domain,
    emailId,
    mailFrom: 'spam@sender.example',
    from: 'spam@sender.example',
    subject: 'Spam',
    message: MESSAGE,
  })
}

test('the admin overview lists every abuse report, newest first', async () => {
  const { repo, app, admin } = setup()
  await report(repo, 'example.com')
  await report(repo, 'other.example')

  const response = await request(app, admin, 'GET', '/admin/domains')

  expect(response.json().abuseReports).toEqual([
    {
      id: 2,
      domain: 'other.example',
      mailFrom: 'spam@sender.example',
      from: 'spam@sender.example',
      subject: 'Spam',
      size: MESSAGE.length,
      receivedAt: expect.any(String),
    },
    expect.objectContaining({ id: 1, domain: 'example.com' }),
  ])

  await app.close()
})

test('an admin reads the message of any abuse report', async () => {
  const { repo, app, admin } = setup()
  await report(repo, 'example.com')

  const found = await request(app, admin, 'GET', '/admin/abuse-reports/1')
  const missing = await request(app, admin, 'GET', '/admin/abuse-reports/2')
  const invalid = await request(app, admin, 'GET', '/admin/abuse-reports/1e3')

  expect(found.statusCode).toBe(200)
  expect(found.headers['content-type']).toBe('message/rfc822')
  expect(found.rawPayload).toEqual(MESSAGE)
  expect(missing.json()).toEqual({ error: 'abuse_report_not_found' })
  expect(invalid.statusCode).toBe(404)

  await app.close()
})

test('only an admin reads the message of an abuse report through the admin route', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await verifyDomain(repo, 'example.com', alice.pubkey)
  await report(repo, 'example.com')

  const response = await request(app, alice, 'GET', '/admin/abuse-reports/1')

  expect(response.statusCode).toBe(403)

  await app.close()
})

test('the owner sees the abuse reports of its domain and reads their messages', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await verifyDomain(repo, 'example.com', alice.pubkey)
  await verifyDomain(repo, 'other.example', signer().pubkey)
  await report(repo, 'example.com')
  await report(repo, 'other.example')

  const listed = await request(app, alice, 'GET', '/domains')
  const own = await request(app, alice, 'GET', '/domains/example.com/abuse-reports/1')
  const other = await request(app, alice, 'GET', '/domains/example.com/abuse-reports/2')

  expect(listed.json().domains[0].abuseReports.map((report: { id: number }) => report.id)).toEqual([1])
  expect(own.statusCode).toBe(200)
  expect(own.rawPayload).toEqual(MESSAGE)
  expect(other.statusCode).toBe(404)
  expect(other.json()).toEqual({ error: 'abuse_report_not_found' })

  await app.close()
})

test('a key that takes a domain over does not see what was reported before', async () => {
  const { repo, app } = setup()
  const alice = signer()
  await report(repo, 'example.com')
  repo.abuseReports[0].report.receivedAt = '2020-01-01T00:00:00.000Z'
  await verifyDomain(repo, 'example.com', alice.pubkey)

  const listed = await request(app, alice, 'GET', '/domains/example.com')
  const read = await request(app, alice, 'GET', '/domains/example.com/abuse-reports/1')

  expect(listed.json().domain.abuseReports).toEqual([])
  expect(read.statusCode).toBe(404)

  await app.close()
})

test('a key without a claim on the domain reads no report of it', async () => {
  const { repo, app } = setup()
  await verifyDomain(repo, 'example.com', signer().pubkey)
  await report(repo, 'example.com')

  const response = await request(app, signer(), 'GET', '/domains/example.com/abuse-reports/1')

  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: 'domain_not_found' })

  await app.close()
})
