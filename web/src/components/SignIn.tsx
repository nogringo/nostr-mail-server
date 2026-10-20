import { type ReactNode, type SubmitEvent, useState } from 'react'
import { describeError } from '../lib/errors'
import { hasExtension, type Signer, signInWithBunker, signInWithExtension } from '../lib/signer'
import { Button, ErrorText } from './ui'

interface Props {
  title: string
  children: ReactNode
  onSignIn: (signer: Signer) => void
}

export default function SignIn({ title, children, onSignIn }: Props) {
  const [bunker, setBunker] = useState('')
  const [busy, setBusy] = useState<'extension' | 'bunker' | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const extension = hasExtension()

  async function run(method: 'extension' | 'bunker', signIn: () => Promise<Signer>) {
    setBusy(method)
    setError(null)
    try {
      onSignIn(await signIn())
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(null)
      setAuthUrl(null)
    }
  }

  function connectBunker(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (bunker.trim()) run('bunker', () => signInWithBunker(bunker, setAuthUrl))
  }

  return (
    <section className="max-w-2xl pt-12 sm:pt-20">
      <h1 className="text-balance font-semibold text-4xl tracking-tight sm:text-5xl">{title}</h1>
      <p className="mt-6 max-w-xl text-lg text-muted leading-relaxed">{children}</p>

      <div className="mt-12 space-y-8">
        <div className="space-y-2">
          <Button disabled={!extension || busy !== null} onClick={() => run('extension', signInWithExtension)}>
            {busy === 'extension' ? 'Waiting for the extension' : 'Sign in with extension'}
          </Button>
          {!extension && <p className="text-muted text-sm">No Nostr extension found in this browser.</p>}
        </div>

        <form onSubmit={connectBunker} className="space-y-2">
          <label htmlFor="bunker" className="block font-medium">
            Or use a bunker
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="bunker"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder="bunker://... or name@domain"
              value={bunker}
              onChange={(event) => setBunker(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm placeholder:text-muted/70"
            />
            <Button type="submit" variant="secondary" disabled={!bunker.trim() || busy !== null}>
              {busy === 'bunker' ? 'Connecting' : 'Connect bunker'}
            </Button>
          </div>
          {authUrl && (
            <p className="text-sm">
              Your bunker asks you to approve this site.{' '}
              <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                Open the approval page
              </a>
            </p>
          )}
        </form>

        <ErrorText>{error}</ErrorText>
      </div>
    </section>
  )
}
