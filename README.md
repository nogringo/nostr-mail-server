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
| Send mail over SMTP, DKIM signed, with a retry queue | done |
| Website: sign in with Nostr, connect a domain, check its records | done |
| Deploy on one machine: HTTPS site and API, SMTP on port 25 | done |
| Website: named addresses (`alice@domain` to any npub) | done |
| NIP-05 over HTTPS on the connected domains (A record, certificate on demand) | done |
| Admin page: every connected domain, its owner, addresses and records | done |
| Admin page: suspend a domain, which stops its mail and NIP-05 | done |
| Website: a list of your domains, then one page per domain in tabs | done |
| Website: a home page that explains the service before the sign-in | done |
| Admin page: domains, suspensions, abuse reports and server DNS in tabs | done |
| Website: a header linking your domains and, for an admin, the admin page | done |
| Domain key: the owner shows its nsec or replaces it with their own nsec | done |
| Domain key held by the owner's bunker (NIP-46) instead of the server | done |
| Private addresses: they receive and send, but NIP-05 does not show their key | done |
| Abuse reports: the admins and the domain owner each delete them for themselves | done |
| Website: sign in with a signer app's QR code (Amber), an nsec or an ncryptsec | done |
| NIP-05 served by the owner's own website instead, checked through `_smtp` | done |
| NIP-05 relayed by the owner's website to this server, private addresses included | done |
| Catch-all: mail to a new address (`shop@`, `you+news@`) creates it; deleted addresses stay deleted | done |
| Disable an address without deleting it: its mail is dropped, the sender cannot tell, and it still sends | done |

## Layout

| Path | What |
|------|------|
| [`server/`](server/) | The API (TypeScript, Fastify, Postgres) |
| [`web/`](web/) | The website (Astro, React, Tailwind) |
| [`deploy/`](deploy/) | Docker Compose and Caddy for one machine |

## How mail flows

Each connected domain gets its own Nostr key, published as `_smtp@<domain>`.

- Inbound: the server receives SMTP for the connected domains, gift wraps each
  message with the domain's key and publishes it to the recipient's DM relays,
  or to its NIP-65 read relays when it lists none.
- Outbound: Nostr Mail clients wrap the mail they send from the domain to
  `_smtp@<domain>`, and the server sends it over SMTP to the recipients' MX,
  signed with the domain's DKIM key.

Clients find both the addresses and the `_smtp` key through NIP-05 on the
address domain. Either the domain points its A record at this server, which
serves its `/.well-known/nostr.json` over HTTPS, or the owner's own website
serves it and lists `_smtp` with the domain key, which the check then looks for.
That website best relays the path to `/nip05/<domain>` on this server, which
answers for every address and keeps the private ones hidden.

## License

MIT
