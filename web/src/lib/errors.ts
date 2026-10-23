import type { Messages } from '../i18n/en'
import { ApiError } from './api'

export function describeError(error: unknown, messages: Messages['errors']): string {
  const code = error instanceof Error ? error.message : String(error)
  const known: Record<string, string> = messages.codes
  if (Object.hasOwn(known, code)) return known[code]
  if (error instanceof ApiError) {
    return error.status === 401 ? messages.signatureRefused(error.code) : messages.status(error.status, error.code)
  }
  // fetch rejects with a TypeError when the request does not get through.
  if (error instanceof TypeError) return messages.unreachable

  return code
}
