# nostr-mail-server

Connect your own domain to [Nostr Mail](https://github.com/nogringo/nostr-mail),
then send and receive SMTP email at `you@yourdomain.com` over Nostr.

The project is built in small steps. What exists today:

| Step | Status |
|------|--------|
| Claim a domain with a Nostr key, get its DNS records, check them live | done |
| Addresses on the domain (`local part -> npub`) and NIP-05 on the domain | next |
| Receive mail (inbound decision for haraka-webhook) | later |
| Send mail (outbound decision for bridge-nostr-smtp, DKIM signing) | later |
| Website: sign in with Nostr, connect a domain, manage addresses | later |

## Layout

| Path | What |
|------|------|
| [`server/`](server/) | The API (TypeScript, Fastify, Postgres) |

## How mail flows

The server is the policy and identity side. It plugs into the existing
transport components:

- Inbound: [haraka-webhook](https://github.com/nogringo/haraka-webhook)
  receives SMTP on port 25 and hands the message to
  [nostr-mail-inbound-webhook](https://github.com/nogringo/nostr-mail-inbound-webhook),
  which gift wraps it to the recipient.
- Outbound: [bridge-nostr-smtp](https://github.com/nogringo/bridge-nostr-smtp)
  unwraps mail sent to the bridge key and relays it through an SMTP smarthost
  such as [postfix-rspamd-docker](https://github.com/nogringo/postfix-rspamd-docker).

Both sides find addresses through NIP-05 on the address domain, which is why a
connected domain has to serve `/.well-known/nostr.json` from this server.

## License

MIT
