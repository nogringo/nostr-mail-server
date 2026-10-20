import { hashPayload, unpackEventFromToken } from 'nostr-tools/nip98'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { expect, test } from 'vitest'
import { createApi } from '../src/lib/api'
import type { Signer } from '../src/lib/signer'

const ORIGIN = 'https://app.example.org'

function localSigner(): Signer {
  const secretKey = generateSecretKey()
  return {
    pubkey: getPublicKey(secretKey),
    signEvent: async (event) => finalizeEvent(event, secretKey),
    close: async () => {},
  }
}

function recordingApi(response: () => Response) {
  const requests: { url: string; init: RequestInit }[] = []
  const api = createApi(localSigner(), ORIGIN, async (url, init) => {
    requests.push({ url, init })
    return response()
  })
  return { api, requests }
}

test('signs each request with NIP-98 for its URL and method', async () => {
  const { api, requests } = recordingApi(() => Response.json({ domain: { domain: 'example.com' } }, { status: 201 }))

  const domain = await api.checkDomain('example.com')

  expect(domain).toEqual({ domain: 'example.com' })
  const [{ url, init }] = requests
  expect(url).toBe(`${ORIGIN}/domains/example.com/check`)
  expect(init.method).toBe('POST')
  const authorization = (init.headers as Record<string, string>).authorization
  expect(authorization).toMatch(/^Nostr /)
  const event = await unpackEventFromToken(authorization)
  expect(event.kind).toBe(27235)
  expect(event.tags).toEqual([
    ['u', url],
    ['method', 'POST'],
  ])
})

test('turns an error answer into an ApiError with its code', async () => {
  const { api } = recordingApi(() => Response.json({ error: 'invalid_domain' }, { status: 400 }))

  await expect(api.connectDomain('nope')).rejects.toMatchObject({ code: 'invalid_domain', status: 400 })
})

test('accepts the empty answer of a removal', async () => {
  const { api, requests } = recordingApi(() => new Response(null, { status: 204 }))

  await api.removeDomain('example.com')

  expect(requests[0].init.method).toBe('DELETE')
})

test('sends a body as JSON and signs its hash', async () => {
  const address = { localPart: 'alice', address: 'alice@example.com', pubkey: 'ab'.repeat(32), createdAt: '' }
  const { api, requests } = recordingApi(() => Response.json({ address }, { status: 201 }))

  expect(await api.putAddress('example.com', 'alice', 'npub1alice')).toEqual(address)

  const [{ url, init }] = requests
  expect(url).toBe(`${ORIGIN}/domains/example.com/addresses/alice`)
  expect(init.body).toBe('{"pubkey":"npub1alice"}')
  const headers = init.headers as Record<string, string>
  expect(headers['content-type']).toBe('application/json')
  const event = await unpackEventFromToken(headers.authorization)
  expect(event.tags).toContainEqual(['payload', hashPayload({ pubkey: 'npub1alice' })])
})

test('loads the overview of the server for an admin', async () => {
  const overview = { domains: [], suspensions: [], abuseReports: [] }
  const { api, requests } = recordingApi(() => Response.json(overview))

  expect(await api.adminOverview()).toEqual(overview)

  expect(requests[0].url).toBe(`${ORIGIN}/admin/domains`)
  expect(requests[0].init.method).toBe('GET')
})

test('suspends a domain and lifts its suspension', async () => {
  const suspension = { domain: 'example.com', suspendedAt: '' }
  const { api, requests } = recordingApi(() =>
    requests.length === 1 ? Response.json({ suspension }, { status: 201 }) : new Response(null, { status: 204 }),
  )

  expect(await api.suspendDomain('example.com')).toEqual(suspension)
  await api.liftSuspension('example.com')

  expect(requests.map(({ url, init }) => [init.method, url])).toEqual([
    ['PUT', `${ORIGIN}/admin/domains/example.com/suspension`],
    ['DELETE', `${ORIGIN}/admin/domains/example.com/suspension`],
  ])
})

test('reads the message of an abuse report as it was received', async () => {
  const message = 'Subject: Spam\r\n\r\nHello\r\n'
  const { api, requests } = recordingApi(() => new Response(message, { headers: { 'content-type': 'message/rfc822' } }))

  expect(await (await api.abuseMessage('example.com', 3)).text()).toBe(message)
  expect(await (await api.adminAbuseMessage(4)).text()).toBe(message)
  expect(requests.map((request) => request.url)).toEqual([
    `${ORIGIN}/domains/example.com/abuse-reports/3`,
    `${ORIGIN}/admin/abuse-reports/4`,
  ])
})

test('turns an error answer to a message read into an ApiError', async () => {
  const { api } = recordingApi(() => Response.json({ error: 'abuse_report_not_found' }, { status: 404 }))

  await expect(api.adminAbuseMessage(9)).rejects.toMatchObject({ code: 'abuse_report_not_found', status: 404 })
})
