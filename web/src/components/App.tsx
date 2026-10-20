import { type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { isKnownAdmin } from '../lib/admins'
import { npubOf, shortNpub } from '../lib/format'
import { restoreSession, type Signer, signOut } from '../lib/signer'
import Admin from './Admin'
import Connect from './Connect'
import Dashboard from './Dashboard'
import DomainPage from './DomainPage'
import SignIn from './SignIn'
import { Button } from './ui'

interface View {
  area: 'domains' | 'admin'
  subtitle: string
  Page: ComponentType<{ signer: Signer }>
  title: string
  intro: ReactNode
}

const OWNER = {
  area: 'domains' as const,
  subtitle: 'for your domain',
  title: 'Sign in with your Nostr key',
  intro: 'It owns the domains you connect: sign in with the same key to manage them later.',
}

const VIEWS: Record<'dashboard' | 'connect' | 'domain' | 'admin', View> = {
  dashboard: { ...OWNER, Page: Dashboard },
  connect: { ...OWNER, Page: Connect },
  domain: { ...OWNER, Page: DomainPage },
  admin: {
    area: 'admin',
    subtitle: 'admin',
    Page: Admin,
    title: 'Server admin',
    intro: 'Sign in with a key listed in ADMIN_PUBKEYS to see every domain connected to this server.',
  },
}

export default function App({ view }: { view: keyof typeof VIEWS }) {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [restoring, setRestoring] = useState(true)
  const { area, subtitle, Page, title, intro } = VIEWS[view]

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
      <header className="flex flex-wrap items-center gap-x-8 gap-y-3 py-6">
        <a href="/" className="font-semibold text-lg tracking-tight">
          Nostr Mail <span className="font-normal text-muted">{subtitle}</span>
        </a>
        {signer && (
          <>
            <nav aria-label="Site" className="order-last flex w-full gap-x-5 text-sm sm:order-none sm:w-auto">
              <NavLink href="/dashboard" current={area === 'domains'}>
                Your domains
              </NavLink>
              {(area === 'admin' || isKnownAdmin(signer.pubkey)) && (
                <NavLink href="/admin" current={area === 'admin'}>
                  Admin
                </NavLink>
              )}
            </nav>
            <div className="ml-auto flex items-center gap-4 text-sm">
              <span className="hidden font-mono text-muted sm:inline">{shortNpub(npubOf(signer.pubkey))}</span>
              <Button variant="quiet" onClick={leave}>
                Sign out
              </Button>
            </div>
          </>
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

function NavLink({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`font-medium ${current ? 'text-ink' : 'text-muted hover:text-ink'}`}
    >
      {children}
    </a>
  )
}
