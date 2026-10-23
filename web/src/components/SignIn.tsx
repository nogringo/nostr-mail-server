import { QRCodeSVG } from 'qrcode.react'
import { type ReactNode, type SubmitEvent, useEffect, useRef, useState } from 'react'
import { useMessages } from '../i18n'
import { describeError } from '../lib/errors'
import {
  hasExtension,
  isEncryptedKey,
  isSecretKey,
  nostrConnect,
  type Signer,
  signInWithBunker,
  signInWithExtension,
  signInWithKey,
} from '../lib/signer'
import { Button, CopyButton, ErrorText } from './ui'

interface Props {
  title: string
  children: ReactNode
  onSignIn: (signer: Signer) => void
  onCancel?: () => void
}

const INPUT =
  'min-w-0 flex-1 rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm placeholder:text-muted/70'

export default function SignIn({ title, children, onSignIn, onCancel }: Props) {
  const t = useMessages()
  const [credential, setCredential] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'extension' | 'bunker' | 'key' | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [connectUri, setConnectUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connectAbort = useRef<AbortController | null>(null)
  const extension = hasExtension()
  const secretKey = isSecretKey(credential)
  const encrypted = isEncryptedKey(credential)

  useEffect(() => () => connectAbort.current?.abort(), [])

  async function run(method: 'extension' | 'bunker' | 'key', signIn: () => Promise<Signer>) {
    setBusy(method)
    setError(null)
    try {
      onSignIn(await signIn())
    } catch (failure) {
      setError(describeError(failure, t.errors))
    } finally {
      setBusy(null)
      setAuthUrl(null)
    }
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!credential.trim()) return
    if (secretKey) run('key', () => signInWithKey(credential, password))
    else run('bunker', () => signInWithBunker(credential, setAuthUrl))
  }

  function showQrCode() {
    const abort = new AbortController()
    const { uri, signedIn } = nostrConnect(abort.signal)
    connectAbort.current = abort
    setConnectUri(uri)
    setError(null)
    signedIn.then(onSignIn, (failure) => {
      if (abort.signal.aborted) return
      setConnectUri(null)
      setError(describeError(failure, t.errors))
    })
  }

  function hideQrCode() {
    connectAbort.current?.abort()
    setConnectUri(null)
  }

  const submitButton = (
    <Button
      type="submit"
      variant="secondary"
      disabled={!credential.trim() || (encrypted && !password) || busy !== null}
    >
      {busy === 'bunker' ? t.signIn.connecting : busy === 'key' ? t.signIn.unlocking : t.common.signIn}
    </Button>
  )

  return (
    <section className="max-w-2xl pt-12 sm:pt-20">
      <h1 className="text-balance font-semibold text-4xl tracking-tight sm:text-5xl">{title}</h1>
      <p className="mt-6 max-w-xl text-lg text-muted leading-relaxed">{children}</p>

      <div className="mt-12 space-y-8">
        <div className="space-y-2">
          <Button disabled={!extension || busy !== null} onClick={() => run('extension', signInWithExtension)}>
            {busy === 'extension' ? t.signIn.waitingForExtension : t.signIn.withExtension}
          </Button>
          {!extension && <p className="text-muted text-sm">{t.signIn.noExtension}</p>}
        </div>

        <div className="space-y-2">
          <h2 className="font-medium">{t.signIn.signerApp}</h2>
          {connectUri ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <QRCodeSVG
                value={connectUri}
                size={224}
                marginSize={4}
                fgColor="#18223a"
                title={t.signIn.qrTitle}
                className="shrink-0 rounded-md border border-rule"
              />
              <div className="space-y-3 text-sm">
                <p className="max-w-xs text-muted">{t.signIn.scan}</p>
                <p className="flex items-center gap-3">
                  <a href={connectUri} className="text-accent underline">
                    {t.signIn.openInApp}
                  </a>
                  <CopyButton text={connectUri} label={t.signIn.connectionLink} />
                </p>
                <Button variant="quiet" onClick={hideQrCode}>
                  {t.signIn.hideQr}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={showQrCode}>
              {t.signIn.showQr}
            </Button>
          )}
        </div>

        <form onSubmit={submit} className="space-y-2">
          <label htmlFor="credential" className="block font-medium">
            {t.signIn.credential}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="credential"
              type={secretKey ? 'password' : 'text'}
              inputMode="url"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder={t.signIn.credentialPlaceholder}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              className={INPUT}
            />
            {!encrypted && submitButton}
          </div>
          {encrypted && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                aria-label={t.signIn.passwordLabel}
                autoComplete="off"
                placeholder={t.signIn.password}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={INPUT}
              />
              {submitButton}
            </div>
          )}
          {secretKey && <p className="text-muted text-sm">{t.signIn.keyStays}</p>}
          {authUrl && (
            <p className="text-sm">
              {t.signIn.approve}{' '}
              <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                {t.signIn.openApproval}
              </a>
            </p>
          )}
        </form>

        <ErrorText>{error}</ErrorText>

        {onCancel && (
          <Button variant="quiet" onClick={onCancel}>
            {t.common.cancel}
          </Button>
        )}
      </div>
    </section>
  )
}
