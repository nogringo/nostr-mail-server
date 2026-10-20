import { useEffect, useState } from 'react'
import { npubOf, shortNpub } from '../lib/format'
import { restoreSession, type Signer, signOut } from '../lib/signer'
import Admin from './Admin'
import Dashboard from './Dashboard'
import SignIn from './SignIn'
import { Button } from './ui'

const VIEWS = {
  dashboard: {
    subtitle: 'for your domain',
    Page: Dashboard,
    title: 'Email at your own domain, delivered over Nostr.',
    intro: (
      <>
        Sign in with your Nostr key, connect a domain you own and publish its DNS records. Mail sent to{' '}
        <span className="font-mono text-base text-ink">npub...@yourdomain.com</span> then reaches you in Nostr Mail.
      </>
    ),
  },
  admin: {
    subtitle: 'admin',
    Page: Admin,
    title: 'Server admin',
    intro: 'Sign in with a key listed in ADMIN_PUBKEYS to see every domain connected to this server.',
  },
}

export default function App({ view = 'dashboard' }: { view?: keyof typeof VIEWS }) {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [restoring, setRestoring] = useState(true)
  const { subtitle, Page, title, intro } = VIEWS[view]

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
          Nostr Mail <span className="font-normal text-muted">{subtitle}</span>
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
          <Page key={signer.pubkey} signer={signer} />
        ) : (
          <SignIn title={title} onSignIn={setSigner}>
            {intro}
          </SignIn>
        )}
      </main>
    </div>
  )
}
