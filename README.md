# nostr-mail-server

Connect your own domain to [Nostr Mail](https://github.com/nogringo/nostr-mail),
then send and receive SMTP email at `you@yourdomain.com` over Nostr.

The project is built in small steps. What exists today:

| Step | Status |
|------|--------|
| Claim a domain with a Nostr key, get its DNS records, check them live | done |
| Addresses on the domain (`local part -> npub`, plus `npub...@domain`) and NIP-05 on the domain | done |
| Receive mail over SMTP and deliver it over Nostr, large mail through Blossom | done |
| STARTTLS on incoming mail | done |
| Check SPF, DKIM and DMARC on incoming mail | done |
| Send mail with the domain's `_smtp` key and DKIM signing | later |
| Website: sign in with Nostr, connect a domain, check its records | done |
| Deploy on one machine: HTTPS site and API, SMTP on port 25 | done |
| Website: named addresses (`alice@domain` to any npub) | done |
| NIP-05 over HTTPS on the connected domains (A record, certificate on demand) | done |

## Layout

| Path | What |
|------|------|
| [`server/`](server/) | The API (TypeScript, Fastify, Postgres) |
| [`web/`](web/) | The website (Astro, React, Tailwind) |
| [`deploy/`](deploy/) | Docker Compose and Caddy for one machine |

## How mail flows

Each connected domain gets its own Nostr key, published as `_smtp@<domain>`.

- Inbound: the server receives SMTP for the connected domains, gift wraps each
  message with the domain's key and publishes it to the recipient's DM relays.
- Outbound (to come): Nostr Mail clients wrap the mail they send from the
  domain to `_smtp@<domain>`, and the server sends it over SMTP, signed with
  the domain's DKIM key.

Clients find both the addresses and the `_smtp` key through NIP-05 on the
address domain, so a connected domain points its A record at this server,
which serves its `/.well-known/nostr.json` over HTTPS.

## License

MIT
