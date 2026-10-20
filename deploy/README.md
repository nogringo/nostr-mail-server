# Deployment

One machine runs everything with Docker Compose:

| Service | What | Published ports |
|---------|------|-----------------|
| `postgres` | Postgres 18 | none |
| `server` | The [API](../server/README.md) and the inbound SMTP server | 25, to the container's 2525 |
| `web` | Caddy: HTTPS with Let's Encrypt, the [site](../web/README.md), the API routes proxied to `server` | 80, 443 |

The site and the API share one origin, `SITE_HOST`, because NIP-98 binds each
request to the URL the browser signs. Caddy sends `/domains`, `/domains/*`,
`/.well-known/nostr.json` and `/healthz` to the server and keeps the `Host`
header.

The connected domains point their A record at `PUBLIC_IPV4`, this machine. For
any other host name, Caddy gets a certificate on demand once the server says
the domain is verified, and serves only `/.well-known/nostr.json` there.

`SITE_HOST` is also the MX that connected domains point at, and for now the
SPF include they are given. The SMTP server offers STARTTLS with the
certificate Caddy obtains for it: the server mounts Caddy's data read-only,
both images run as uid 10001 since Caddy keeps its keys readable by their owner
only, and Caddy uses Let's Encrypt alone so the files stay at the same path.

## Setup

1. Point an A record for `SITE_HOST` at the machine, and open ports 25, 80
   and 443.
2. Copy the repository to the machine, then:

```sh
cd deploy
cp .env.example .env    # set SITE_HOST, PUBLIC_IPV4 and POSTGRES_PASSWORD
sudo docker compose up -d --build
```

Caddy gets the certificate when it starts. To update, copy the new code
and run `sudo docker compose up -d --build` again. Logs:
`sudo docker compose logs -f server`.

The SMTP server waits for that certificate: on a first start it restarts until
Caddy has it, which takes a few seconds once the A record resolves.

Not done yet: an SPF record for `SITE_HOST`, needed to send mail.
