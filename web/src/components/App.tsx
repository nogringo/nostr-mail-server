import { type ComponentType, useEffect, useState } from 'react'
import { LOCALES, type Locale, LocaleContext, localize, MESSAGES } from '../i18n'
import { isKnownAdmin } from '../lib/admins'
import { listAccounts, restoreSession, type Signer, signOut, switchAccount } from '../lib/signer'
import AccountMenu from './AccountMenu'
import Admin from './Admin'
import Connect from './Connect'
import Dashboard from './Dashboard'
import DomainPage from './DomainPage'
import SignIn from './SignIn'
import { useHash } from './Tabs'
import { LanguageLink } from './ui'

interface View {
  area: 'domains' | 'admin'
  Page: ComponentType<{ signer: Signer }>
  // Picks which of the signed-in accounts opens the page.
  prefer?: (pubkey: string) => boolean
}

const VIEWS: Record<'dashboard' | 'connect' | 'domain' | 'admin', View> = {
  dashboard: { area: 'domains', Page: Dashboard },
  connect: { area: 'domains', Page: Connect },
  domain: { area: 'domains', Page: DomainPage },
  admin: { area: 'admin', Page: Admin, prefer: isKnownAdmin },
}

export default function App({ view, locale }: { view: keyof typeof VIEWS; locale: Locale }) {
  const [signer, setSigner] = useState<Signer | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [adding, setAdding] = useState(false)
  const hash = useHash()
  const { area, Page, prefer } = VIEWS[view]
  const t = MESSAGES[locale]

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
    <LocaleContext value={locale}>
      <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-8">
        <header className="flex flex-wrap items-center gap-x-8 gap-y-3 py-6">
          <a href={localize('/', locale)} className="font-semibold text-lg tracking-tight">
            Nostr Mail <span className="font-normal text-muted">{t.app.subtitle[area]}</span>
          </a>
          {signer && (
            <nav aria-label={t.app.nav} className="order-last flex w-full gap-x-5 text-sm sm:order-none sm:w-auto">
              <NavLink href={localize('/dashboard', locale)} current={area === 'domains'}>
                {t.common.yourDomains}
              </NavLink>
              {(area === 'admin' || listAccounts().some((account) => isKnownAdmin(account.pubkey))) && (
                <NavLink href={localize('/admin', locale)} current={area === 'admin'}>
                  {t.app.admin}
                </NavLink>
              )}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-5 text-sm">
            {signer && (
              <AccountMenu
                pubkey={signer.pubkey}
                onSwitch={async (pubkey) => activate(await switchAccount(pubkey))}
                onAdd={() => setAdding(true)}
                onSignOut={leave}
              />
            )}
            {LOCALES.filter((other) => other !== locale).map((other) => (
              <LanguageLink
                key={other}
                locale={other}
                href={`${localize(`/${view}`, other)}${window.location.search}${hash && `#${hash}`}`}
              />
            ))}
          </div>
        </header>
        <main>
          {restoring ? null : adding ? (
            <SignIn title={t.app.addAccount} onSignIn={activate} onCancel={() => setAdding(false)}>
              {t.app.addAccountIntro}
            </SignIn>
          ) : signer ? (
            <Page key={signer.pubkey} signer={signer} />
          ) : (
            <SignIn title={t.app.signIn[area].title} onSignIn={activate}>
              {t.app.signIn[area].intro}
            </SignIn>
          )}
        </main>
      </div>
    </LocaleContext>
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
