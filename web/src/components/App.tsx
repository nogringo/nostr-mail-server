import { useEffect, useState } from 'react'
import { npubOf, shortNpub } from '../lib/format'
import { restoreSession, type Signer, signOut } from '../lib/signer'
import Dashboard from './Dashboard'
import SignIn from './SignIn'
import { Button } from './ui'

export default function App() {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [restoring, setRestoring] = useState(true)

  useEffect(() => {
    restoreSession()
      .then(setSigner)
      .finally(() => setRestoring(false))
  }, [])

  async function leave() {
    if (signer) await signOut(signer)
    setSigner(null)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6">
        <p className="font-semibold text-lg tracking-tight">
          Nostr Mail <span className="font-normal text-muted">for your domain</span>
        </p>
        {signer && (
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden font-mono text-muted sm:inline">{shortNpub(npubOf(signer.pubkey))}</span>
            <Button variant="quiet" onClick={leave}>
              Sign out
            </Button>
          </div>
        )}
      </header>
      <main>
        {restoring ? null : signer ? (
          <Dashboard key={signer.pubkey} signer={signer} />
        ) : (
          <SignIn onSignIn={setSigner} />
        )}
      </main>
    </div>
  )
}
