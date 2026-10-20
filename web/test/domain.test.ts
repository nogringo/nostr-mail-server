import { expect, test } from 'vitest'
import type { Domain, RecordId } from '../src/lib/api'
import { domainStatus } from '../src/lib/domain'

const IDS: RecordId[] = ['ownership', 'mx', 'https', 'spf', 'dkim', 'dmarc']

function domainWith(found: RecordId[], fields: Partial<Domain> = {}): Domain {
  return {
    domain: 'example.com',
    verifiedAt: '2026-10-20T10:00:00Z',
    suspendedAt: null,
    checkedAt: '2026-10-20T10:00:00Z',
    blossomServers: [],
    createdAt: '2026-10-20T09:00:00Z',
    records: IDS.map((id) => ({
      id,
      type: 'TXT',
      name: '',
      value: '',
      required: id !== 'dmarc',
      check: { status: found.includes(id) ? 'ok' : 'missing', found: [] },
    })),
    abuseReports: [],
    ...fields,
  }
}

test('names what a domain waits for next', () => {
  expect(domainStatus(domainWith([], { checkedAt: null, verifiedAt: null })).text).toBe(
    'Publish the DNS records, then check them',
  )
  expect(domainStatus(domainWith([], { verifiedAt: null })).text).toBe('Waiting for the ownership record')
  expect(domainStatus(domainWith(['ownership'])).text).toBe('Verified, waiting for the MX record')
  expect(domainStatus(domainWith(['ownership', 'mx', 'https'])).text).toBe(
    'Receiving mail, waiting for SPF and DKIM to send',
  )
  expect(domainStatus(domainWith(['ownership', 'mx', 'https', 'spf', 'dkim']))).toEqual({
    tone: 'ok',
    text: 'Sending and receiving mail',
  })
})

test('puts a suspension before the records', () => {
  const status = domainStatus(domainWith(IDS, { suspendedAt: '2026-10-20T11:00:00Z' }))

  expect(status).toEqual({ tone: 'bad', text: 'Suspended by the admin of this server' })
})
