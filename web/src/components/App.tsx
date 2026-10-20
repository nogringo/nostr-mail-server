import { type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { npubOf, shortNpub } from '../lib/format'
import { restoreSession, type Signer, signOut } from '../lib/signer'
import Admin from './Admin'
import Connect from './Connect'
import Dashboard from './Dashboard'
import DomainPage from './DomainPage'
import SignIn from './SignIn'
import { Button } from './ui'

interface View {
  subtitle: string
  Page: ComponentType<{ signer: Signer }>
  title: string
  intro: ReactNode
}

const OWNER = {
  subtitle: 'for your domain',
  title: 'Sign in with your Nostr key',
  intro: 'It owns the domains you connect: sign in with the same key to manage them later.',
}

const VIEWS: Record<'dashboard' | 'connect' | 'domain' | 'admin', View> = {
  dashboard: { ...OWNER, Page: Dashboard },
  connect: { ...OWNER, Page: Connect },
  domain: { ...OWNER, Page: DomainPage },
  admin: {
    subtitle: 'admin',
    Page: Admin,
    title: 'Server admin',
    intro: 'Sign in with a key listed in ADMIN_PUBKEYS to see every domain connected to this server.',
  },
}

export default function App({ view }: { view: keyof typeof VIEWS }) {
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
