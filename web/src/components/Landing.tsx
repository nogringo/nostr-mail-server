import { ButtonLink } from './ui'

const ADDRESSES = [
  { address: 'npub1sg6p...0x9k@yourdomain.com', deliveredTo: 'your key, always available' },
  { address: 'alice@yourdomain.com', deliveredTo: 'npub1x7dk...m3qa' },
  { address: 'team@yourdomain.com', deliveredTo: 'npub1q8ve...4k2v' },
]

const STEPS = [
  {
    title: 'Sign in with your Nostr key',
    text: 'Use a browser extension or a bunker. The key you sign in with owns the domains you connect.',
  },
  {
    title: 'Connect a domain and publish its DNS records',
    text: 'The site lists each record to add at your DNS provider, then checks them for you.',
  },
  {
    title: 'Read and send its mail in Nostr Mail',
    text: 'Mail sent to the domain reaches its keys over Nostr. Mail you send from it leaves signed for the domain, so receivers trust it.',
  },
]

// Rendered at build time: the page needs no script and touches no signer.
export default function Landing() {
  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6">
        <p className="font-semibold text-lg tracking-tight">
          Nostr Mail <span className="font-normal text-muted">for your domain</span>
        </p>
        <ButtonLink variant="quiet" href="/dashboard" className="text-sm">
          Sign in
        </ButtonLink>
      </header>

      <main>
        <section className="max-w-2xl pt-12 sm:pt-20">
          <h1 className="text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
            Email at your own domain, delivered over Nostr.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted leading-relaxed">
            Connect a domain you own. Mail sent to its addresses reaches Nostr keys in Nostr Mail, and you send from the
            domain too.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
            <ButtonLink href="/connect">Connect your domain</ButtonLink>
            <ButtonLink variant="quiet" href="https://github.com/nogringo/nostr-mail">
              Get Nostr Mail
            </ButtonLink>
          </div>
        </section>

        <figure className="mt-16 max-w-2xl">
          <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
            {ADDRESSES.map(({ address, deliveredTo }) => (
              <li key={address} className="px-4 py-3">
                <p className="break-all font-mono text-sm leading-6">{address}</p>
                <p className="text-muted text-sm">Delivered to {deliveredTo}</p>
              </li>
            ))}
          </ul>
          <figcaption className="mt-3 text-muted text-sm">
            Your key always has its npub address. Add named ones for anyone, each pointing at their key. Every address
            is also its key's NIP-05 identifier.
          </figcaption>
        </figure>

        <section className="mt-20 max-w-2xl" aria-labelledby="how">
          <h2 id="how" className="font-semibold text-2xl tracking-tight">
            How it works
          </h2>
          <ol className="mt-8 space-y-8">
            {STEPS.map(({ title, text }, index) => (
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
          Source code
        </ButtonLink>
      </footer>
    </div>
  )
}
