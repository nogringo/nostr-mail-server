import { type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { isKnownAdmin } from '../lib/admins'
import { listAccounts, restoreSession, type Signer, signOut, switchAccount } from '../lib/signer'
import AccountMenu from './AccountMenu'
import Admin from './Admin'
import Connect from './Connect'
import Dashboard from './Dashboard'
import DomainPage from './DomainPage'
import SignIn from './SignIn'

interface View {
  area: 'domains' | 'admin'
  subtitle: string
  Page: ComponentType<{ signer: Signer }>
  title: string
  intro: ReactNode
  // Picks which of the signed-in accounts opens the page.
  prefer?: (pubkey: string) => boolean
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
    prefer: isKnownAdmin,
  },
}

export default function App({ view }: { view: keyof typeof VIEWS }) {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [adding, setAdding] = useState(false)
  const { area, subtitle, Page, title, intro, prefer } = VIEWS[view]

  useEffect(() => {
    restoreSession(prefer)
      .then(setSigner)
      .finally(() => setRestoring(false))
  }, [prefer])

  // Only the account in use keeps its bunker connected.
  async function activate(next: Signer) {
    await signer?.close()
    setSigner(next)
    setAdding(false)
  }

  async function leave() {
    if (signer) await signOut(signer)
    setSigner(await restoreSession(prefer))
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
              {(area === 'admin' || listAccounts().some((account) => isKnownAdmin(account.pubkey))) && (
                <NavLink href="/admin" current={area === 'admin'}>
                  Admin
                </NavLink>
              )}
            </nav>
            <div className="ml-auto text-sm">
              <AccountMenu
                pubkey={signer.pubkey}
                onSwitch={async (pubkey) => activate(await switchAccount(pubkey))}
                onAdd={() => setAdding(true)}
                onSignOut={leave}
              />
            </div>
          </>
        )}
      </header>
      <main>
        {restoring ? null : adding ? (
          <SignIn title="Add an account" onSignIn={activate} onCancel={() => setAdding(false)}>
            Sign in with another key. The menu at the top of every page switches between your accounts.
          </SignIn>
        ) : signer ? (
          <Page key={signer.pubkey} signer={signer} />
        ) : (
          <SignIn title={title} onSignIn={activate}>
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
