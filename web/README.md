# nostr-mail-server website

Sign in with a Nostr key, connect a domain, publish the DNS records it shows
and check them. Once the domain is verified, the page lists its addresses:
`npub...@<domain>`, always available, and the named ones the owner adds, each
pointing at an npub or a hex public key.

Sign-in uses a NIP-07 extension or a NIP-46 bunker (`bunker://` link or
`name@domain`). Every API call is signed with
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) for the
page's own origin, so the site and the API must be served on the same origin.

Astro builds a static site with a single React page.

## Development

Start the [API](../server/README.md) on port 3000, then:

```sh
npm install
npm run dev         # http://localhost:4321, /domains proxied to the API
```

`API_URL` points the proxy at another API (default `http://localhost:3000`).

```sh
npm run check       # Biome
npm run typecheck   # astro check
npm test            # Vitest
npm run build       # static site in dist/
```
