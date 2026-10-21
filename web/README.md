# nostr-mail-server website

`/` is the home page: what the service does and how it works, rendered at
build time with no script. The other pages ask for a Nostr key first.
`/dashboard` lists the domains of the key with the state of each. `/connect`
connects a new domain and opens its page.

`/domain?name=<domain>` is the page of one domain, in tabs:

- Addresses, once the domain is verified: `npub...@<domain>`, always
  available, and the named ones the owner adds, each pointing at an npub or a
  hex public key.
- DNS: the records to publish, and their check.
- Abuse reports: the mail sent to `abuse@<domain>` since the owner verified
  it, each message shown or downloaded as `.eml`.
- Settings: the domain key (`_smtp@<domain>`), whose nsec the owner can show,
  replace with one of their own or hand to their bunker with a `bunker://`
  link, and removing the domain.

The page opens on DNS until the domain sends and receives mail, then on
Addresses. Each tab has its own URL fragment (`#dns`, `#abuse`, etc.).

`/admin` sums up the server, then splits it in tabs:

- Domains: every domain connected to the server, verified or not, with its
  owner, its named addresses and the records of its last check. Each one can
  be suspended.
- Access: who can connect a domain (the admins and the allowed keys, or any
  key), then the allowed keys, with the adding and removal of a key. A key that may not connect a domain sees, on
  its domains page and on `/connect`, that the server is private, with its
  npub to send to the admin.
- Suspended: the suspended domains, and the lifting of a suspension.
- Abuse: the mail sent to `abuse@` of every domain.
- Server: the server's own DNS records (A, PTR and SPF), checked each time the
  page loads. The page opens on this tab while a record needs fixing.

`/admin/*` is the API, so the tabs are URL fragments (`/admin#abuse`). Only
the keys of the server's `ADMIN_PUBKEYS` can open the page.

Signed in, the header of every page links to the key's domains. It links to
`/admin` too once the key has opened it in this browser: the site remembers
these keys in `localStorage` rather than asking the server on every page.

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
