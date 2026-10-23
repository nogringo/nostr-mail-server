import type { Tone } from '../components/ui'
import { type Locale, localize } from '../i18n'
import type { Messages } from '../i18n/en'
import type { Domain, RecordId } from './api'

export function domainHref(name: string, locale: Locale): string {
  return `${localize('/domain', locale)}?name=${encodeURIComponent(name)}`
}

export function domainStatus(domain: Domain, messages: Messages['domainStatus']): { tone: Tone; text: string } {
  const found = (id: RecordId) => domain.records.find((record) => record.id === id)?.check?.status === 'ok'
  if (domain.suspendedAt) return { tone: 'bad', text: messages.suspended }
  if (!domain.checkedAt) return { tone: 'wait', text: messages.unchecked }
  if (!domain.verifiedAt) return { tone: 'wait', text: messages.unverified }
  if (!found('mx')) return { tone: 'wait', text: messages.noMx }
  if (!found('nip05')) {
    return { tone: 'wait', text: domain.nip05 === 'server' ? messages.waitingForA : messages.waitingForNip05 }
  }
  if (!found('spf') || !found('dkim')) return { tone: 'wait', text: messages.waitingForSending }
  return { tone: 'ok', text: messages.ok }
}
