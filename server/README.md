# nostr-mail-server API

Lets a Nostr key claim a domain, tells it which DNS records to publish, checks
them, then lets the owner declare addresses that the domain serves over NIP-05.
Mail sent to those addresses over SMTP is delivered to their pubkeys over Nostr.

## Domains

Every route is authenticated with
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
(`Authorization: Nostr <base64 kind-27235 event>`), bound to the method and to
the host and path of the request. The signing pubkey owns the claims it makes.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/domains` | List the caller's claims |
| `PUT` | `/domains/{domain}` | Claim a domain: `201` when created, `200` when the caller already claimed it, `400 invalid_domain` |
| `GET` | `/domains/{domain}` | One claim, `404 domain_not_found` if the caller has none |
| `POST` | `/domains/{domain}/check` | Look the records up now and store the result |
| `DELETE` | `/domains/{domain}` | Release the claim: `204`, or `404 domain_not_found` |

A domain is returned as:

```json
{
  "domain": "example.com",
  "verifiedAt": null,
  "checkedAt": "2026-10-20T12:00:00.000Z",
  "blossomServers": ["https://blossom.nmail.li"],
  "createdAt": "2026-10-20T11:58:00.000Z",
  "records": [
    {
      "id": "ownership",
      "type": "TXT",
      "name": "_nostr-mail.example.com",
      "value": "nostr-mail-verification=0f3c...",
      "required": true,
      "check": { "status": "missing", "found": [] }
    }
  ]
}
```

`check` is `null` until the first check. Its `status` is `ok`, `missing`,
`mismatch` or `error` (the lookup failed), and `found` holds what DNS returned,
so a client can show what is wrong.

### Records

| id | Type | Name | Value | Passes when |
|----|------|------|-------|-------------|
| `ownership` | TXT | `_nostr-mail.<domain>` | `nostr-mail-verification=<token>` | The claim's token is among the values |
| `mx` | MX | `<domain>` | `MX_HOST`, priority 10 | Every MX is `MX_HOST` |
| `https` | A | `<domain>` | `PUBLIC_IPV4` | Every A record is `PUBLIC_IPV4`, and there is no AAAA record |
| `spf` | TXT | `<domain>` | `v=spf1 include:<SPF_INCLUDE> ~all` | One SPF record, which includes `SPF_INCLUDE` |
| `dkim` | TXT | `<selector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<key>` | Its `p=` is the claim's public key |
| `dmarc` | TXT | `_dmarc.<domain>` | `v=DMARC1; p=none` | One DMARC record, any policy (recommended, not required) |

Each claim gets its own token, its own 2048-bit DKIM key and its own Nostr key
pair, served as `_smtp@<domain>` (see [NIP-05](#nip-05)), all generated when it
is created. The private keys stay on the server. It also gets the Blossom
servers of `BLOSSOM_SERVERS` at that time, which store its large mail.

### Lists of the domain key

The domain key writes the mail the domain receives, so clients read its lists
to find what it refers to. Every check that finds the domain verified
publishes, signed by that key, on `DOMAIN_RELAYS` and `INDEXER_RELAYS`:

| Kind | Content |
|------|---------|
| 10002 (NIP-65) | `DOMAIN_RELAYS`, the relays where its lists are found |
| 10063 (BUD-03) | The claim's Blossom servers |

A failed publication is logged and does not fail the check: checking again
publishes the lists again.

### Ownership

Several keys may claim the same domain. The first one whose ownership record is
found becomes its owner and the other claims are dropped. Verification is not
lost when a later check misses the record, but a new key that publishes its own
token takes the domain over: DNS is the source of truth.

## Addresses

The verified owner of a domain declares its addresses, each pointing a local
part at a pubkey. Same NIP-98 authentication as the domain routes.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/domains/{domain}/addresses` | List the addresses of the domain |
| `PUT` | `/domains/{domain}/addresses/{localPart}` | Body `{"pubkey": "<hex or npub>"}`: `201` when created, `200` when an existing address now points at this pubkey |
| `DELETE` | `/domains/{domain}/addresses/{localPart}` | `204`, or `404 address_not_found` |

Every route answers `404 domain_not_found` when the caller has no claim on the
domain and `409 domain_not_verified` while its claim is not verified. `PUT`
also answers `400` with `invalid_local_part`, `reserved_local_part` or
`invalid_pubkey`.

An address is returned as:

```json
{
  "localPart": "alice",
  "address": "alice@example.com",
  "pubkey": "<hex>",
  "createdAt": "2026-10-20T12:00:00.000Z"
}
```

A local part is lowercased and keeps to the NIP-05 characters: dot-separated
runs of `a-z`, `0-9`, `-` and `_`, 64 characters at most. Reserved names
cannot be declared:

- `_smtp`, the domain's own key.
- Anything starting with `npub1`: an npub local part already resolves to its
  pubkey on every verified domain without being declared.

The addresses belong to the owner's claim: they are deleted with it, when the
owner releases the domain or when another key takes it over.

## NIP-05

`GET /.well-known/nostr.json?name=<local part>` answers on the connected
domains themselves: the domain is taken from the `Host` header, so their HTTPS
has to reach this server. It needs no authentication and sends
`Access-Control-Allow-Origin: *`.

On a verified domain, `name` resolves to:

| `name` | Pubkey |
|--------|--------|
| `_smtp` | The domain's own key, which clients wrap the mail they send from the domain to |
| `npub1...` | The pubkey it encodes |
| A declared address | Its pubkey |

```json
{ "names": { "alice": "<hex>" } }
```

An unknown name, or any name on a domain that is not verified, returns
`{"names": {}}`. A missing `name` is `400 name_required`. There is no `relays`
field: Nostr Mail finds relays through kind 10050.

The domain's `https` record points it at `PUBLIC_IPV4`, where the reverse proxy
gets its certificate on demand. Before that, it asks
`GET /certificates/allowed?domain=<domain>`, which answers `200` for a verified
domain and `404` otherwise, so pointing any name at the server does not make it
request certificates. The proxy should not expose this route.

## Receiving mail

The server also speaks SMTP on `SMTP_PORT`, where the `MX_HOST` of the
connected domains points (port 25 in production). There is no queue: a message
is published to Nostr before the server answers, and anything that fails is
answered with a temporary error so the sending server retries.

| Step | Answer |
|------|--------|
| `RCPT TO` on a domain that is not verified, or a local part that is neither a declared address nor an npub | `550 5.1.1` |
| `RCPT TO` whose pubkey publishes no DM relay list (kind 10050) | `450 4.2.0` |
| More than 50 recipients | `452 4.5.3` |
| Message above `MAX_MESSAGE_BYTES` | `552 5.3.4` |
| Message failing DMARC from a domain whose policy is `reject` | `550 5.7.1` |
| The same, while the SPF or a DKIM lookup failed | `451 4.7.0` |
| No Blossom server stores a large message, a recipient's relays all refuse it, or the database fails | `451` |
| Every recipient's wrap accepted by at least one of its relays | `250` |

Each recipient gets its own gift wrap (NIP-59) of a kind 1301 rumor written by
the `_smtp` key of the recipient's domain, as the Nostr Mail protocol describes
for mail from a legacy sender:

- `content` is the MIME, after the `Return-Path`, `Received-SPF`,
  `Authentication-Results` and `Received` headers the server adds on top.
- `email-id` is the SHA-256 of the message as received, so a retried delivery
  keeps the same id.
- `mail-from` is the SMTP envelope sender.

### Large messages

NIP-44 caps what a gift wrap can carry, so a MIME of 32 KB or more goes to
Blossom, as Nostr Mail clients expect:

1. The MIME is encrypted with AES-256-GCM under a random key and nonce. The
   blob is the ciphertext followed by the 16-byte tag.
2. The blob is uploaded (BUD-02) to the Blossom servers of the recipient's
   domain and to the ones the recipient lists in its own kind 10063, with a
   BUD-11 token signed by a domain key and scoped to each server and to the
   blob. One server storing it is enough.
3. The rumor's `content` is empty and it carries `x` (SHA-256 of the blob),
   `encryption-algorithm` (`aes-gcm`), `decryption-key` and
   `decryption-nonce` (both base64). Every recipient gets the same blob.

Clients look for the blob on the servers of the most recent kind 10063 among
the author (the domain key) and the recipient, then on their own defaults. The
blob is on both lists, and `BLOSSOM_SERVERS` defaults to the servers Nostr
Mail clients always check as a last resort.

DM relays are looked up on `INDEXER_RELAYS`, then on the pubkey's NIP-65 write
relays, along with their Blossom servers (kind 10063). A list is written by
whoever holds the key, so only public `wss://` and `https://` hosts are
contacted, at most 8 of each per recipient. The server answers
NIP-42 AUTH with the domain's key.

### STARTTLS

With `TLS_CERT_FILE` and `TLS_KEY_FILE`, the server offers STARTTLS with that
certificate, which should be valid for `MX_HOST`. It does not start when the
files cannot be read. It reads them again every hour, so a renewed certificate
applies to the next connections without a restart; a pair that does not match
is logged and the previous one stays. Without these settings STARTTLS is not
offered.

### SPF, DKIM and DMARC

Every message is checked with [mailauth](https://github.com/postalsys/mailauth)
before it is delivered: SPF of the envelope sender (of the HELO name for a
bounce) against the client address, each `DKIM-Signature`, DMARC of the `From`
domain, and ARC. The results go above the server's `Received` line, under the
`MX_HOST` name:

```
Return-Path: <alice@sender.example>
Received-SPF: pass (mx.example.org: domain of alice@sender.example designates 192.0.2.1 as permitted sender) ...
Authentication-Results: mx.example.org;
 dkim=pass header.i=@sender.example header.s=mail header.a=rsa-sha256 header.b=cFGJUfAx;
 spf=pass (...) smtp.mailfrom=alice@sender.example smtp.helo=mail.sender.example;
 dmarc=pass (p=REJECT arc=none) policy.dmarc=reject header.from=sender.example header.d=sender.example
Received: from ...
```

Only a DMARC failure on a domain whose policy is `reject` refuses the message,
as that domain asks. When a lookup of SPF or of a DKIM key failed, the message
might pass once it works, so it is deferred instead. Everything else is delivered with its results, and the
recipient's client decides: `quarantine`, `none`, a `reject` in test mode
(`t=y`), or SPF failing alone, which forwarding often causes. ARC is reported,
never used to override DMARC, since anyone can seal a message.

An `Authentication-Results` field that arrives with the message under the
`MX_HOST` name is removed (RFC 8601 section 5), so the only one left with that
name is the server's. `email-id` stays the hash of the message as received.

SPF reads the address of the sending server, so it has to reach the server
unchanged. Docker keeps it for IPv4 port publishing, not for IPv6, where its
proxy connects from the gateway: give `MX_HOST` no AAAA record unless IPv6
reaches the container directly.

## Configuration

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | | Postgres connection string |
| `MX_HOST` | yes | | Inbound SMTP host that connected domains point their MX at |
| `SPF_INCLUDE` | yes | | Domain whose SPF record lists the outbound SMTP servers |
| `PUBLIC_IPV4` | yes | | IPv4 address that connected domains point their A record at, so that their HTTPS reaches this server |
| `DKIM_SELECTOR` | no | `nostrmail` | Selector given to new claims; existing claims keep theirs |
| `DNS_SERVERS` | no | system resolver | Comma-separated IP addresses used for the record checks and for SPF, DKIM and DMARC |
| `PORT` | no | `3000` | HTTP port |
| `SMTP_PORT` | no | `2525` | SMTP port that receives mail for the connected domains |
| `MAX_MESSAGE_BYTES` | no | `26214400` (25 MiB) | Largest message accepted over SMTP, advertised with `SIZE` |
| `BLOSSOM_SERVERS` | no | `https://blossom.nmail.li`, `https://blossom.yakihonne.com`, `https://blossom.ditto.pub` | Comma-separated `https://` Blossom servers given to new claims for their large mail; existing claims keep theirs |
| `DOMAIN_RELAYS` | no | `wss://relay.nmail.li`, `wss://relay.ditto.pub`, `wss://nos.lol`, `wss://relay.primal.net` | Comma-separated `wss://` relays the domain keys announce (kind 10002) and publish their lists on |
| `INDEXER_RELAYS` | no | `wss://purplepag.es`, `wss://user.kindpag.es`, `wss://indexer.coracle.social` | Comma-separated `wss://` relays where relay lists (kinds 10002 and 10050) are looked up |
| `TLS_CERT_FILE` | no | | PEM certificate for `MX_HOST` offered with STARTTLS, set together with `TLS_KEY_FILE` |
| `TLS_KEY_FILE` | no | | PEM private key of that certificate |

The pending files of `migrations/` are applied at startup.

## Development

```sh
npm install
docker compose -f docker-compose.dev.yml up -d   # Postgres on localhost:5432
npm run dev
```

```sh
npm run check       # Biome: format, lint and import order (check:write fixes)
npm run typecheck
npm test            # Vitest, once (test:watch reruns on change)
```

The Biome configuration is [`biome.json`](../biome.json) at the repository root,
so it also covers the other packages.

The repository test runs against a real Postgres when `TEST_DATABASE_URL` is
set, inside a throwaway schema it drops afterwards:

```sh
TEST_DATABASE_URL=postgres://nostrmail:nostrmail@localhost:5432/nostrmail npm test
```
