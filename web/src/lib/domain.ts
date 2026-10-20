import type { Tone } from '../components/ui'
import type { Domain, RecordId } from './api'

export function domainHref(name: string): string {
  return `/domain?name=${encodeURIComponent(name)}`
}

export function domainStatus(domain: Domain): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.records.find((record) => record.id === id)?.check?.status === 'ok'
  if (domain.suspendedAt) return { tone: 'bad', text: 'Suspended by the admin of this server' }
  if (!domain.checkedAt) return { tone: 'wait', text: 'Publish the DNS records, then check them' }
  if (!domain.verifiedAt) return { tone: 'wait', text: 'Waiting for the ownership record' }
  if (!found('mx')) return { tone: 'wait', text: 'Verified, waiting for the MX record' }
  if (!found('https')) return { tone: 'wait', text: 'Receiving mail, waiting for the A record' }
  if (!found('spf') || !found('dkim')) return { tone: 'wait', text: 'Receiving mail, waiting for SPF and DKIM to send' }
  return { tone: 'ok', text: 'Sending and receiving mail' }
}
