# nostr-mail-server API

Lets a Nostr key claim a domain, tells it which DNS records to publish, checks
them, then lets the owner declare addresses that the domain serves over NIP-05.

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
| `spf` | TXT | `<domain>` | `v=spf1 include:<SPF_INCLUDE> ~all` | One SPF record, which includes `SPF_INCLUDE` |
| `dkim` | TXT | `<selector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<key>` | Its `p=` is the claim's public key |
| `dmarc` | TXT | `_dmarc.<domain>` | `v=DMARC1; p=none` | One DMARC record, any policy (recommended, not required) |

Each claim gets its own token, its own 2048-bit DKIM key and its own Nostr key
pair, served as `_smtp@<domain>` (see [NIP-05](#nip-05)), all generated when it
is created. The private keys stay on the server.

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

## Configuration

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | | Postgres connection string |
| `MX_HOST` | yes | | Inbound SMTP host that connected domains point their MX at |
| `SPF_INCLUDE` | yes | | Domain whose SPF record lists the outbound SMTP servers |
| `DKIM_SELECTOR` | no | `nostrmail` | Selector given to new claims; existing claims keep theirs |
| `DNS_SERVERS` | no | system resolver | Comma-separated IP addresses used for the checks |
| `PORT` | no | `3000` | HTTP port |

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
