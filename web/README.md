# nostr-mail-server website

Sign in with a Nostr key. `/` leads a signed in key to `/dashboard`, the list
of its domains with the state of each. `/connect` connects a new domain and
opens its page.

`/domain?name=<domain>` is the page of one domain, in tabs:

- Addresses, once the domain is verified: `npub...@<domain>`, always
  available, and the named ones the owner adds, each pointing at an npub or a
  hex public key.
- DNS: the records to publish, and their check.
- Abuse reports: the mail sent to `abuse@<domain>` since the owner verified
  it, each message shown or downloaded as `.eml`.
- Settings: removing the domain.

The page opens on DNS until the domain sends and receives mail, then on
Addresses. Each tab has its own URL fragment (`#dns`, `#abuse`, etc.).

`/admin` lists every domain connected to the server, verified or not, with
its owner, its named addresses and the records of its last check, and
suspends a domain or lifts its suspension. It also lists the mail sent to
`abuse@` of every domain, and checks the server's own DNS records (A, PTR and
SPF) each time it loads. Only the keys of the server's `ADMIN_PUBKEYS` can
open it.

Sign-in uses a NIP-07 extension or a NIP-46 bunker (`bunker://` link or
`name@domain`). Every API call is signed with
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) for the
page's own origin, so the site and the API must be served on the same origin.

Astro builds a static site, one `<name>.html` per page, each mounting the same
React app on its own view.

## Development

Start the [API](../server/README.md) on port 3000, then:

```sh
npm install
npm run dev         # http://localhost:4321, /domains and /admin/* proxied to the API
```

`API_URL` points the proxy at another API (default `http://localhost:3000`).

```sh
npm run check       # Biome
npm run typecheck   # astro check
npm test            # Vitest
npm run build       # static site in dist/, each page as <name>.html
```
