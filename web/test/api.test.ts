import { unpackEventFromToken } from 'nostr-tools/nip98'
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
