import { LOCALES, type Locale, localize, MESSAGES } from '../i18n'
import { ButtonLink, LanguageLink } from './ui'

// Rendered at build time: the page needs no script and touches no signer.
export default function Landing({ locale }: { locale: Locale }) {
  const t = MESSAGES[locale]
  const addresses = [
    { address: `npub1sg6p...0x9k@${t.exampleDomain}`, deliveredTo: t.common.yourKeyAlwaysAvailable },
    { address: `alice@${t.exampleDomain}`, deliveredTo: 'npub1x7dk...m3qa' },
    { address: `team@${t.exampleDomain}`, deliveredTo: 'npub1q8ve...4k2v' },
  ]

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6">
        <p className="font-semibold text-lg tracking-tight">
          Nostr Mail <span className="font-normal text-muted">{t.app.subtitle.domains}</span>
        </p>
        <div className="flex items-center gap-5 text-sm">
          {LOCALES.filter((other) => other !== locale).map((other) => (
            <LanguageLink key={other} locale={other} href={localize('/', other)} />
          ))}
          <ButtonLink variant="quiet" href={localize('/dashboard', locale)}>
            {t.common.signIn}
          </ButtonLink>
        </div>
      </header>

      <main>
        <section className="max-w-2xl pt-12 sm:pt-20">
          <h1 className="text-balance font-semibold text-4xl tracking-tight sm:text-5xl">{t.landing.title}</h1>
          <p className="mt-6 max-w-xl text-lg text-muted leading-relaxed">{t.landing.intro}</p>
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
            <ButtonLink href={localize('/connect', locale)}>{t.landing.connect}</ButtonLink>
            <ButtonLink variant="quiet" href="https://github.com/nogringo/nostr-mail">
              {t.landing.getApp}
            </ButtonLink>
          </div>
        </section>

        <figure className="mt-16 max-w-2xl">
          <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
            {addresses.map(({ address, deliveredTo }) => (
              <li key={address} className="px-4 py-3">
                <p className="break-all font-mono text-sm leading-6">{address}</p>
                <p className="text-muted text-sm">{t.common.deliveredTo(deliveredTo)}</p>
              </li>
            ))}
          </ul>
          <figcaption className="mt-3 text-muted text-sm">{t.landing.caption}</figcaption>
        </figure>

        <section className="mt-20 max-w-2xl" aria-labelledby="how">
          <h2 id="how" className="font-semibold text-2xl tracking-tight">
            {t.landing.how}
          </h2>
          <ol className="mt-8 space-y-8">
            {t.landing.steps.map(({ title, text }, index) => (
              <li key={title} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2">
                <span className="font-semibold text-accent text-lg leading-7" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-medium text-lg leading-7">{title}</h3>
                  <p className="mt-1 text-muted leading-relaxed">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="mt-24 border-rule border-t pt-6 text-sm">
        <ButtonLink variant="quiet" href="https://github.com/nogringo/nostr-mail-server">
          {t.landing.source}
        </ButtonLink>
      </footer>
    </div>
  )
}
