import { expect, test } from 'vitest'
import { removeForgedResults } from '../src/authentication.js'

const remove = (message: string) =>
  removeForgedResults(Buffer.from(message, 'latin1'), 'mx.example.org').toString('latin1')

test('a folded field naming the server is removed whole', () => {
  const message =
    'Authentication-Results: MX.example.org;\r\n\tdkim=pass\r\n header.d=bank.example\r\nSubject: Hi\r\n\r\nBody'

  expect(remove(message)).toBe('Subject: Hi\r\n\r\nBody')
})

test('a comment before the name and a version after it still name the server', () => {
  const message = 'authentication-results : (forged) mx.example.org 1; spf=pass\r\nSubject: Hi\r\n\r\nBody'

  expect(remove(message)).toBe('Subject: Hi\r\n\r\nBody')
})

test('fields of other servers and the body are kept as they are', () => {
  const message = [
    'Authentication-Results: relay.example; spf=pass',
    'Authentication-Results: mx.example.org.evil.example; dkim=pass',
    'Subject: Hi',
    '',
    'Authentication-Results: mx.example.org; dkim=pass',
    '',
  ].join('\r\n')
  const buffer = Buffer.from(message)

  expect(removeForgedResults(buffer, 'mx.example.org')).toBe(buffer)
})

test('a message without header fields is left alone', () => {
  const message = '\r\nAuthentication-Results: mx.example.org; dkim=pass\r\n'

  expect(remove(message)).toBe(message)
})

test('a message without a body loses its forged field', () => {
  expect(remove('Subject: Hi\r\nAuthentication-Results: mx.example.org; dkim=pass\r\n')).toBe('Subject: Hi\r\n')
})

test('bare line feeds are read like CRLF', () => {
  expect(remove('Authentication-Results: mx.example.org; dkim=pass\nSubject: Hi\n\nBody')).toBe('Subject: Hi\n\nBody')
})
