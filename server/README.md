# nostr-mail-server API

Lets a Nostr key claim a domain, tells it which DNS records to publish, checks
them, then lets the owner declare addresses that the domain serves over NIP-05.
Mail sent to those addresses over SMTP is delivered to their pubkeys over Nostr,
and mail their pubkeys send from them over Nostr goes out over SMTP.

## Domains

Every route is authenticated with
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
(`Authorization: Nostr <base64 kind-27235 event>`), bound to the method and to
the host and path of the request. The signing pubkey owns the claims it makes.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/domains` | `{"domains": [...], "canClaim": true, "sharedDomains": [...], "addresses": [...], "quotas": {...}, "usage": {"addresses": 3}}`: the caller's claims, whether it may [claim a new domain](#who-can-claim), the [shared domains](#shared-domains) of other keys and the addresses it created there, its [quotas](#quotas), and the addresses it holds on every domain |
| `PUT` | `/domains/{domain}` | Claim a domain: `201` when created, `200` when the caller already claimed it, `400 invalid_domain`, `403 not_allowed` when the caller [may not claim](#who-can-claim), `403 domain_suspended` for a new claim on a suspended domain, `403 pending_domain_quota` when the caller has as many claims waiting for verification as its [quotas](#quotas) allow |
| `GET` | `/domains/{domain}` | One claim, `404 domain_not_found` if the caller has none |
| `POST` | `/domains/{domain}/check` | Look the records up now and store the result, `403 domain_suspended` on a suspended domain |
| `GET` | `/domains/{domain}/key` | `{"nsec": "nsec1..."}`, the secret of the [domain key](#domain-key), `409 key_in_bunker` when a bunker holds it |
| `PUT` | `/domains/{domain}/key` | Body `{"nsec": "nsec1..."}` or `{"bunker": "bunker://..."}`: the domain key becomes this one, see [Domain key](#domain-key) |
| `PUT` | `/domains/{domain}/shared` | Body `{"shared": true}`: let any key [create addresses](#shared-domains) on the domain, or stop, `400 invalid_shared`, `409 domain_catch_all` while the catch-all is on, `403 domain_suspended` |
| `PUT` | `/domains/{domain}/catch-all` | Body `{"catchAll": true}`: turn the [catch-all](#catch-all) on or off, `400 invalid_catch_all`, `409 domain_shared` while anyone can create addresses on the domain, `403 domain_suspended` |
| `DELETE` | `/domains/{domain}` | Release the claim: `204`, or `404 domain_not_found` |

A domain is returned as:

```json
{
  "domain": "example.com",
  "bridgePubkey": "<hex of the domain key>",
  "bridgeSigner": "server",
  "verifiedAt": null,
  "suspendedAt": null,
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
  ],
  "abuseReports": []
}
```

`check` is `null` until the first check. Its `status` is `ok`, `missing`,
`mismatch` or `error` (the lookup failed), and `found` holds what DNS returned,
so a client can show what is wrong.

`abuseReports` lists the [abuse reports](#abuse-reports) of the domain received
since the claim was verified, newest first. A key that takes a domain over does
not see those of the previous owner.

### Who can claim

Unless an admin [opens registration](#settings), only the keys of
`ADMIN_PUBKEYS` and the [allowed keys](#allowed-keys) make new claims. Any other key gets
`403 not_allowed`. The gate is on new claims only: a key taken off the list
keeps its claims, which a [suspension](#suspension) stops.

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
is created. The DKIM private key stays on the server. It also gets the
[Blossom servers](#settings) of the server at that time, which store the large
mail it receives.

### Domain key

The owner of a claim, verified or not, reads the nsec of its domain key with
`GET /domains/{domain}/key`, answered with `Cache-Control: no-store`, also
while the domain is suspended.

`PUT /domains/{domain}/key` replaces it with the key of the given nsec, or with
the key a NIP-46 bunker holds, and answers the domain. A replaced key is gone
for good, and so is the mail clients wrapped to it that waits to be sent, since
only that key opens it. The same key moved between the server and a bunker
keeps that mail. When the claim is verified, the
[lists](#lists-of-the-domain-key) of the new key are published at once, and the
[server's relay](#receiving-the-wraps) takes the mail wrapped to it right away. Giving the nsec the server already
holds changes nothing. It answers `400 invalid_nsec`, `400 owner_key` for the
key that owns the claim (the server opens every gift wrap sent to the domain
key and replaces its lists), `409 key_in_use` for the key of another claim,
`403 domain_suspended` and `404 domain_not_found`.

`bridgeSigner` tells who holds the private key: `server` or `bunker`.

#### Bunker

The bunker URL needs at least one public `wss://` relay. The server connects
with a client key of its own, sends the secret of the URL, asks for
`nip44_encrypt`, `nip44_decrypt` and `sign_event` of kinds 13 (seals), 22242
(NIP-42), 24242 (Blossom uploads), 10002, 10050 and 10063 (the lists), then
checks NIP-44 both ways. It then keeps the client key and the bunker's pubkey
and relays, not the secret. It answers `400 invalid_bunker_url`,
`504 bunker_timeout` after 60 seconds, `502 bunker_refused`, and
`502 bunker_auth_url` when the bunker wants its owner to approve in a browser,
which a server cannot do: a `bunker://` URL with its secret avoids it.

Every use of the key then goes through the bunker, each request given 30
seconds. A bunker that does not answer delays the mail rather than loses it:

- Incoming mail is answered `451`, and the sender tries again.
- A wrap to the domain key is answered `rate-limited`, which Nostr Mail clients
  send again later, and a queued email waits for its next attempt.

What the bunker refuses is final: the wrap is refused. NIP-46 encrypts each
request once more and relays commonly cap events at 64 KiB, so a request stays
under 40 KiB. Incoming mail over 16 KiB therefore goes to Blossom, and an
email a client wraps inline above about 19 KiB of MIME cannot be opened: it is
refused. Clients move mail to Blossom above 32 KiB, which a bunker opens.
Some public relays also limit how fast a key publishes, which NIP-46 traffic
can hit: a relay made for bunkers suits it better.

### Lists of the domain key

The domain key writes the mail the domain receives, so clients read its lists
to find what it refers to. Every check that finds the domain verified
publishes, signed by that key, on the indexer relays of the
[settings](#settings):

| Kind | Content |
|------|---------|
| 10002 (NIP-65) | The [server's relay](#receiving-the-wraps), as a read relay only, since it serves nothing |
| 10050 (NIP-17) | The server's relay, where clients send the mail the domain relays |
| 10063 (BUD-03) | The server's [Blossom endpoint](#receiving-the-blobs), where clients upload the large mail the domain sends |

A failed publication is logged and does not fail the check: checking again
publishes the lists again. Every verified domain key publishes its lists again
when an admin changes the indexer relays, and when the server starts with a
relay its lists do not name yet (a new `MX_HOST`).

### Ownership

Several keys may claim the same domain. The first one whose ownership record is
found becomes its owner and the other claims are dropped. Verification is not
lost when a later check misses the record, but a new key that publishes its own
token takes the domain over: DNS is the source of truth.

Once a claim on a domain is verified, the server remembers that it served the
domain, for good: its [`abuse@`](#abuse-reports) still takes mail after the
claim is released.

## Addresses

The verified owner of a domain declares its addresses, each pointing a local
part at one pubkey or more. Same NIP-98 authentication as the domain routes.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/domains/{domain}/addresses` | `{"addresses": [...], "deletedAddresses": [...]}`: the addresses of the domain and the [deleted](#deleted-addresses) ones |
| `PUT` | `/domains/{domain}/addresses/{localPart}` | Body `{"pubkeys": ["<hex or npub>"], "private": false, "enabled": true}`: `201` when created, `200` when an existing address now points at these pubkeys with this privacy and state, `409 address_deleted` for a deleted one, `403 address_quota` or `429 address_rate_quota` for a new one past the caller's [quotas](#quotas), `403 keys_per_address_quota` for more pubkeys than they allow |
| `DELETE` | `/domains/{domain}/addresses/{localPart}` | `204`, or `404 address_not_found`. The address joins the deleted ones |
| `DELETE` | `/domains/{domain}/deleted-addresses/{localPart}` | Let a deleted address be created again: `204`, or `404 deleted_address_not_found` |
| `DELETE` | `/domains/{domain}/deleted-addresses` | Let every deleted address be created again: `204` |

Every route answers `404 domain_not_found` when the caller has no claim on the
domain, `409 domain_not_verified` while its claim is not verified and
`403 domain_suspended` while the domain is [suspended](#suspension). `PUT`
also answers `400` with `invalid_local_part`, `reserved_local_part`,
`invalid_pubkeys`, `invalid_private` or `invalid_enabled`.

An address is returned as:

```json
{
  "localPart": "alice",
  "address": "alice@example.com",
  "pubkeys": ["<hex>"],
  "private": false,
  "enabled": true,
  "createdAt": "2026-10-20T12:00:00.000Z"
}
```

An address delivers its mail to every pubkey it lists, each in its own wrap,
and each of them sends from it, as a SimpleLogin alias does with its
mailboxes. A repeated pubkey is kept once, and a pubkey without inbox relays
is skipped while another one has some. [NIP-05](#nip-05) shows one pubkey
per name, and a Nostr client that finds it writes to it directly, so it shows
none for an address with several: mail from Nostr clients then comes through
SMTP and reaches them all. Once the address is back to one pubkey, NIP-05 shows
it again unless the address is private. Only the owner gives an address
several pubkeys: one on a [shared domain](#shared-domains) delivers to the key
that created it.

An address is public unless `private` is `true`. A private address receives
and sends like a public one, but [NIP-05](#nip-05) does not show its pubkey:
nobody can link the address to the key it reaches. `PUT` without `private`
makes the address public.

An address is enabled unless `enabled` is `false`. A disabled address takes
its mail and drops it, answering `250` like a delivery so the sender cannot
tell, as SimpleLogin does. NIP-05 hides it too, or Nostr clients would write to
its key around it. It still sends, and the catch-all does not create it again,
since it exists. A disabled `abuse` still brings complaints to the owner and the
admins, just not to its own pubkeys. `PUT` without `enabled` enables the address.

A local part is lowercased and keeps to the NIP-05 characters: dot-separated
runs of `a-z`, `0-9`, `-` and `_`, 64 characters at most. The
[catch-all](#catch-all) creates other ones too, like `you+news`, which the
owner then manages like the rest, URL-encoded in the path. Reserved names
cannot be declared:

- `_smtp`, the domain's own key.
- Anything starting with `npub1`: an npub local part already resolves to its
  pubkey on every verified domain without being declared.

The addresses belong to the owner's claim: they are deleted with it, when the
owner releases the domain or when another key takes it over.

### Shared domains

On a domain its owner shares, any key creates addresses that deliver to itself,
and keeps managing them once the domain is no longer shared. The owner can
still remove them.

| Method | Path | Action |
|--------|------|--------|
| `PUT` | `/addresses/{domain}/{localPart}` | Body `{"private": false, "enabled": true}`: `201` when created, `200` when the caller changed one it created, `403 domain_not_shared`, `409 address_taken` when another key has it, `409 address_deleted`, `400 reserved_local_part` for `_smtp`, `npub1...` and the names only the owner gives (`abuse`, `postmaster`, `support`, `admin`, `noreply` and the like), `403 address_quota` or `429 address_rate_quota` for a new one past the caller's [quotas](#quotas) |
| `DELETE` | `/addresses/{domain}/{localPart}` | Delete an address the caller created: `204`, or `404 address_not_found`. It joins the [deleted](#deleted-addresses) ones |

### Deleted addresses

A deleted address is kept aside, and nothing creates it again, neither the
owner, nor a key on a shared domain, nor the catch-all, until the owner lets it
go. Mail to it is refused meanwhile: an address that leaked is dropped for
good, and nobody gets the mail meant for whoever used it before. A deleted
address is returned as:

```json
{
  "localPart": "shop",
  "address": "shop@example.com",
  "deletedAt": "2026-10-23T12:00:00.000Z"
}
```

The deleted addresses go with the claim, like the addresses.

### Catch-all

With the catch-all on, mail to an address the domain does not know creates it
for the owner's key, private, the first time it arrives: `shop@` or
`you+news@` need no declaring. A `+` is no separator: `you+news` is an address
of its own, which the owner can delete without touching `you`. Reserved names
and deleted addresses are never created, nor any address past the
[quotas](#quotas) of the owner: the mail is then refused like for an unknown
address, as SimpleLogin does.

A domain is shared or catch-all, not both, since the catch-all would take the
names a shared domain leaves to the keys that create them: sharing a catch-all
domain answers `409 domain_catch_all`.

## Admin

The keys of `ADMIN_PUBKEYS` see every domain connected to the server, with the
same NIP-98 authentication. Any other key gets `403 not_admin`.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/admin/domains` | `{"domains": [...], "suspensions": [...], "allowedKeys": [...], "keyQuotas": [...], "settings": {...}, "abuseReports": [...], "serverRecords": [...]}`: every claim of every key, verified or not, sorted by domain then by age, every suspended domain, the [allowed keys](#allowed-keys), the keys with [quotas](#quotas) of their own, the [settings](#settings), every [abuse report](#abuse-reports), newest first, and the [server's own records](#server-records) |
| `GET` | `/admin/abuse-reports/{id}` | The message of any abuse report, or `404 abuse_report_not_found` |
| `DELETE` | `/admin/abuse-reports/{id}` | [Delete the abuse report](#abuse-reports) for the admins: `204`, or `404 abuse_report_not_found` |
| `PUT` | `/admin/domains/{domain}/suspension` | Suspend the domain, claimed or not: `201` when suspended, `200` when it already was, `400 invalid_domain` |
| `DELETE` | `/admin/domains/{domain}/suspension` | Lift the suspension: `204`, or `404 suspension_not_found` |
| `PUT` | `/admin/allowed-keys/{npub or hex}` | Let the key [claim domains](#who-can-claim): `201` when added, `200` when it already was, `400 invalid_pubkey` |
| `DELETE` | `/admin/allowed-keys/{npub or hex}` | Take the key off the list: `204`, or `404 allowed_key_not_found` |
| `PUT` | `/admin/key-quotas/{npub or hex}` | Body `{"quotas": {"addresses": 100}}`: give the key [quotas](#quotas) of its own, in place of those it had: `201` when it had none, `200` otherwise, `400 invalid_pubkey`, `400 invalid_quotas` |
| `DELETE` | `/admin/key-quotas/{npub or hex}` | Give the key the quotas of the server back: `204`, or `404 key_quotas_not_found` |
| `PATCH` | `/admin/settings` | Body with any of the [settings](#settings), the others keep their value, and so do the quotas left out of `quotas`: returns them all as `{"settings": {...}}`, or `400` with `invalid_open_registration`, `invalid_max_message_bytes`, `invalid_max_blob_storage_bytes`, `invalid_blossom_servers`, `invalid_indexer_relays` or `invalid_quotas` |

A claim is returned as:

```json
{
  "domain": "example.com",
  "pubkey": "<hex of the claiming key>",
  "verifiedAt": "2026-10-20T12:00:00.000Z",
  "checkedAt": "2026-10-20T12:00:00.000Z",
  "createdAt": "2026-10-20T11:58:00.000Z",
  "addressCount": 2,
  "checks": {
    "ownership": { "status": "ok", "found": ["nostr-mail-verification=0f3c..."] },
    "mx": { "status": "ok", "found": ["10 mx.example.org"] }
  }
}
```

`checks` holds the six records of the last check, `null` before the first one.
`addressCount` counts the named addresses the claim declared. A suspension is
returned as `{"domain": "example.com", "suspendedAt": "<date>"}`.

### Allowed keys

The keys an admin lets [claim domains](#who-can-claim), besides the admins,
oldest first. Each one is returned as
`{"pubkey": "<hex>", "allowedAt": "<date>"}`. The list is not used while
registration is open.

### Settings

What the admins change from the site, stored in Postgres and applied without a
restart:

| Setting | Default | Description |
|---------|---------|-------------|
| `openRegistration` | `false` | When `true`, any key [claims domains](#who-can-claim) |
| `maxMessageBytes` | `26214400` (25 MiB) | Largest message accepted over SMTP, advertised with `SIZE` from the next connection, and largest blob read to send. Between 64 KiB and 1 GiB |
| `maxBlobStorageBytes` | `1073741824` (1 GiB) | Largest size of the [blobs](#receiving-the-blobs) the server holds together, past which uploads are refused. Between 64 KiB and 1 TiB |
| `blossomServers` | `https://blossom.nmail.li`, `https://blossom.yakihonne.com`, `https://blossom.ditto.pub` | `https://` Blossom servers given to new claims for the large mail they receive, and used by the server's own key; existing claims keep theirs |
| `indexerRelays` | `wss://purplepag.es/`, `wss://user.kindpag.es/`, `wss://indexer.coracle.social/` | `wss://` relays where the lists of other pubkeys (kinds 10002, 10050 and 10063) are looked up, and where the domain keys publish their [lists](#lists-of-the-domain-key) |
| `quotas` | every one `null` | The [quotas](#quotas) of every key |

URLs must point at public hosts, and each list needs one at least.

### Quotas

What a key may do: the server's quotas apply to every key, unless an admin gave
it quotas of its own. A quota is a whole number, or `null` for no limit. The
admins have none.

| Quota | Counts | Once reached |
|-------|--------|--------------|
| `addresses` | The addresses the key created, on its own domains, those their catch-all created included, and on shared ones. Deleting one frees its place | A new address answers `403 address_quota`, and the catch-all of the key's domains creates none |
| `addressesPerHour` | The addresses the key created over the last hour, deleted since or not | A new address answers `429 address_rate_quota`, and the catch-all creates none |
| `pendingDomains` | The key's claims whose ownership record is not found yet | A new claim answers `403 pending_domain_quota` |
| `recipientsPerDay` | The recipients each domain of the key sent to over the last 24 hours, whoever sent from it | A mail that would go over is [refused](#receiving-the-wraps) |
| `keysPerAddress` | The pubkeys one address the key declares delivers to. One is always allowed, and an address keeps the pubkeys it has when the quota goes down | Giving an address more answers `403 keys_per_address_quota` |

A key with quotas of its own is returned as
`{"pubkey": "<hex>", "quotas": {"addresses": 100, "recipientsPerDay": null}, "updatedAt": "<date>"}`:
a quota left out is the server's.

### Server records

`serverRecords` are the records the server itself needs, looked up on every
call through `DNS_SERVERS`:

| `id` | Record | Found when |
|------|--------|------------|
| `host` | A of `MX_HOST` | Its only address is `PUBLIC_IPV4`: any other A or any AAAA is a mismatch |
| `ptr` | PTR of `PUBLIC_IPV4` | It names `MX_HOST`, the name the server greets with when it sends |
| `spf` | TXT of `SPF_INCLUDE` | A record with `include:<SPF_INCLUDE>` passes SPF for `PUBLIC_IPV4`, so `a`, `mx` or a wider `ip4` range count too |
| `nostr` | A of `nostr.MX_HOST` | Its only address is `PUBLIC_IPV4`, like `host`, whether an A record or a CNAME gives it: the [relay](#receiving-the-wraps) and [Blossom server](#receiving-the-blobs) the domain keys announce answer there |

Each is returned as:

```json
{
  "id": "spf",
  "type": "TXT",
  "name": "_spf.example.org",
  "value": "v=spf1 ip4:203.0.113.10 -all",
  "check": { "status": "ok", "found": ["v=spf1 ip4:203.0.113.10 -all"] }
}
```

`value` is the suggested record. `status` is `ok`, `missing`, `mismatch` or
`error` when a lookup failed, as for the records of a domain.

### Suspension

A suspension takes the domain name out of service, whichever key claims it:

- `RCPT TO` on the domain is refused with `550 5.1.1`, except
  [`abuse@`](#abuse-reports).
- NIP-05 resolves no name on it and Caddy gets it no new certificate.
- Its key stops listening for wraps within 30 seconds, and the mail it still
  had queued fails at its next attempt.
- No new claim is made on it, and its owner can no longer check it or manage
  its addresses. The owner still sees it, marked as suspended, and can release
  it; the suspension stays.

Lifting the suspension puts back the verified claim with its addresses as they
were. Its key listens again from two days back, so wraps sent meanwhile are
sent then.

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
| A declared address with one pubkey, neither private nor disabled | Its pubkey |

```json
{ "names": { "alice": "<hex>" } }
```

An unknown, private or disabled name, one with several pubkeys, or any name on a domain that is not verified or is suspended, returns
`{"names": {}}`. A missing `name` is `400 name_required`. There is no `relays`
field: Nostr Mail finds relays through kind 10050.

The domain's `https` record points it at `PUBLIC_IPV4`, where the reverse proxy
gets its certificate on demand. Before that, it asks
`GET /certificates/allowed?domain=<domain>`, which answers `200` for a verified
domain that is not suspended and `404` otherwise, so pointing any name at the server does not make it
request certificates. The proxy should not expose this route.

## Receiving mail

The server also speaks SMTP on `SMTP_PORT`, where the `MX_HOST` of the
connected domains points (port 25 in production). There is no queue: a message
is published to Nostr before the server answers, and anything that fails is
answered with a temporary error so the sending server retries.

| Step | Answer |
|------|--------|
| `RCPT TO` on a domain that is not verified or is suspended, or a local part that is neither a declared address, an npub, `abuse`, nor one the [catch-all](#catch-all) creates (`abuse` is taken on a suspended domain, on one the server served once, and on `MX_HOST`) | `550 5.1.1` |
| `RCPT TO` on an address none of whose pubkeys has inbox relays (neither DM relays in a kind 10050 nor read relays in a kind 10002), except to `abuse` | `450 4.2.0` |
| `RCPT TO` on a [disabled](#addresses) address | `250`, and the message is dropped for it |
| More than 50 recipients | `452 4.5.3` |
| Message above [`maxMessageBytes`](#settings) | `552 5.3.4` |
| Message failing DMARC from a domain whose policy is `reject` | `550 5.7.1` |
| The same, while the SPF or a DKIM lookup failed | `451 4.7.0` |
| No Blossom server stores a large message, a recipient's relays all refuse it, or the database fails | `451` |
| Every recipient's wrap accepted by at least one of its relays | `250` |

Each recipient pubkey gets its own gift wrap (NIP-59) of a kind 1301 rumor written by
the `_smtp` key of the recipient's domain, as the Nostr Mail protocol describes
for mail from a legacy sender:

- `content` is the MIME, after the `Return-Path`, `Received-SPF`,
  `Authentication-Results` and `Received` headers the server adds on top.
- `email-id` is the SHA-256 of the message as received, so a retried delivery
  keeps the same id.
- `mail-from` is the SMTP envelope sender.

### Abuse reports

`abuse@<domain>` (RFC 2142) always exists on a verified domain. It reaches the
domain owner and every key of `ADMIN_PUBKEYS`, plus the pubkeys it is declared
to, if any: the server sends the domain's mail, so its admins hear about
complaints too. Each of them gets one wrap. A pubkey without inbox relays is
skipped rather than deferring the complaint, which the server keeps anyway.

`abuse@` keeps taking mail when the domain is out of service: while it is
[suspended](#suspension), and after its claim is released if the server
served it once, as complaints about the mail it sent can come later. A
suspended domain's verified owner and the admins get it as usual. When nobody
owns the domain any more, or it was suspended before anyone claimed it, no
domain key is left to write it, so the admins get it written by the server's
own key. `abuse@MX_HOST`, where complaints about the server's address go, also
reaches the admins under that key. A domain the server never served nor
suspended takes no mail at all.

The server's key is created on its first start and stored in the database; its
hex pubkey is logged as `serverPubkey` when SMTP starts listening. When nobody
can get a complaint over Nostr (no admin, or no inbox relays), the server answers
`250` with `Kept on this server`.

The server also keeps every message sent to `abuse@`, once per domain, before
publishing it to Nostr: a delivery the sender retries is not kept twice, and
the report is kept even while the relays refuse it. A report is listed as:

```json
{
  "id": 3,
  "domain": "example.com",
  "mailFrom": "reports@isp.example",
  "from": "ISP Abuse Desk <reports@isp.example>",
  "subject": "Spam from your domain",
  "size": 4812,
  "receivedAt": "2026-10-20T12:00:00.000Z"
}
```

`from` and `subject` are the decoded fields, cut at 300 characters. The
message itself, as delivered over Nostr with the trace fields on top, is read
as `message/rfc822` from `GET /admin/abuse-reports/{id}` by an admin, or from
`GET /domains/{domain}/abuse-reports/{id}` by the owner of the domain, with the
same NIP-98 authentication. The owner gets `404 domain_not_found` without a
claim on the domain and `404 abuse_report_not_found` for a report that is not
in its list.

The admins and the owner each delete a report for themselves, with `DELETE` on
the same paths: `204`, or the same `404` errors. The admins keep the reports
the owner deletes, so a domain cannot hide the complaints about it, and the
owner keeps the reports the admins delete. The message is dropped from the
server once nobody reads it any more: both deleted it, or the admins did and
no owner gets it (a report received before the current claim, or none). The
wraps already delivered over Nostr stay with their recipients.

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

Clients look for the blob on the servers of the kind 10063 of the author (the
domain key) and of the recipient, then on their own defaults. The domain key's
list names the server's [Blossom endpoint](#receiving-the-blobs), which only
holds the mail the domains send, so the blob is found on the recipient's
servers or on the claim's: the default [Blossom servers](#settings) are the
ones Nostr Mail clients always check as a last resort.

A recipient's wrap goes to its inbox relays: its DM relays (kind 10050) when it
lists any, else the read relays of its NIP-65 list (kind 10002). The NIP-65
list is looked up on the [indexer relays](#settings). The DM relays and the Blossom servers
(kind 10063) are looked up there too and on the pubkey's NIP-65 write relays,
and the most recent list wins. A list is written by
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

## Sending mail

A Nostr Mail client sends mail for a legacy recipient through the domain of its
From address: it resolves `_smtp@<domain>` and gift wraps a kind 1301 rumor to
that key, the SMTP envelope in its tags (`mail-from`, then one `rcpt-to` per
recipient, Cc and Bcc included). The server delivers it over SMTP, DKIM signed
by the domain.

### Receiving the wraps

The domain keys announce one relay, the server's own: `wss://nostr.MX_HOST`. It
is a NIP-01 relay that takes the gift wraps (kind 1059) tagged with a verified
domain key, checks each one as it arrives, and answers `OK`:

| Answer | When |
|--------|------|
| `true` | The email is queued, or the wrap was taken before |
| `false`, `blocked: <refusal>` | The wrap is refused, for one of the reasons below |
| `false`, `rate-limited: ...` | The wrap cannot be checked now, a bunker that does not answer for instance: Nostr Mail clients send it again later |
| `false`, `blocked: ...` or `invalid: ...` | Another kind, a wrap tagged with no domain key of the server, a bad id or signature, or a date in the future |

It serves nothing: a `REQ` is answered `CLOSED`. A wrap that comes again while
it is checked gets the same answer.

The relays the domain keys announced before are still listened to for seven
days, for the clients that have not read the new kind 10050. There, each
verified domain key has its own subscription to the kind 1059 events tagged
with it, on its own connections, answering NIP-42 AUTH with its key since a DM
relay may serve the gift wraps of only one authenticated key per connection.
NIP-59 dates a wrap up to two days back, so a subscription reaches two days
back too, and every subscription is renewed every 10 minutes to recover from
dropped connections. A wrap seen again is recognized by its id and handled
once.

A wrap is refused, and never sent, when:

| Check | Refusal |
|-------|---------|
| The domain's last check found SPF and DKIM | `<domain> does not send mail until its SPF and DKIM records are found` |
| The wrap opens with the domain key, its seal is signed by the rumor's author, and the rumor is a kind 1301 | The wrap does not hold an email |
| A blob, if the rumor points to one, is in the clear or named with `aes-gcm`, its key and its nonce | The email points to a blob it gives no way to decrypt |
| `mail-from` is an address of the domain that delivers to the author: a declared name among whose pubkeys the author is, private or not, or the author's own `npub1...` | `<address> is not an address of the sender` |
| 1 to 50 `rcpt-to` tags, each `local@domain` with a dot-atom local part | Not an address mail can be relayed to |
| The domain stays within the [quota](#quotas) of its owner: its recipients over the last 24 hours, this mail's included | `<domain> sends mail to <n> recipients a day at most` |

The refusal is recorded with the wrap id and logged.

### Receiving the blobs

Clients move the MIME of an email of 32 KB or more to a Blossom blob, uploaded
to the servers of the domain key's kind 10063: the server's own,
`https://nostr.MX_HOST`. It has a host name of its own, apart from the site,
so that no blob anyone uploads shares the site's origin, and it serves every
blob with `X-Content-Type-Options: nosniff`.

| Method | Path | Action |
|--------|------|--------|
| `PUT` | `/upload` | BUD-02 upload, the blob as the body: `200` with its descriptor (`url`, `sha256`, `size`, `type`, `uploaded`), `401 missing_auth`, `403 invalid_auth`, `400 empty_blob`, `413 blob_too_large` above [`maxMessageBytes`](#settings) and the 16-byte tag, or `507 blob_storage_full` when the blobs held would go past [`maxBlobStorageBytes`](#settings) |
| `GET`, `HEAD` | `/<sha256>`, an extension allowed | The blob, or `404 blob_not_found` |

An upload carries `Authorization: Nostr <base64 kind 24242 event>`, signed by
any key since clients often use a throwaway one, with a `t` tag `upload`, an
`expiration` in the future, `x` tags that name the blob if any, and `server`
tags that name `MX_HOST` if any. A refusal gives its reason in `X-Reason`, and
every answer lets any origin read it.

A blob is kept while an email in it waits: the outbox reads it from here, and
an email that was waiting for it goes out as soon as it comes. It is deleted
within the hour once its email has an outcome for every recipient, or a day
after its upload when no email took it.

### Delivery

An accepted wrap is queued in Postgres, the wrap itself kept until every
recipient has an outcome. Delivery then:

1. Reads the MIME: the rumor's `content`, or for a large email the Blossom blob
   its tags point to, [uploaded to the server](#receiving-the-blobs), else
   looked for on the domain's servers and the default ones, then on the
   sender's kind 10063, checked against its hash. The blob is decrypted with
   its `encryption-algorithm` (`aes-gcm`), `decryption-key` and
   `decryption-nonce` tags, or read as it is when the rumor has none of them,
   as a public email may leave its blob in the clear.
2. Checks the `From` field: one address, which belongs to the sender like
   `mail-from`. DMARC aligns it with the DKIM signature, so it cannot name
   anyone else. Otherwise every recipient fails.
3. Signs the message with the domain's DKIM key (relaxed/relaxed, rsa-sha256),
   lines turned into CRLF first.
4. Sends one transaction per recipient domain, straight to its MX hosts in
   order of preference (the domain itself without MX), on port 25, greeting as
   `MX_HOST` and with STARTTLS when offered, without checking the certificate.

| Answer | Outcome |
|--------|---------|
| 2xx | Delivered |
| 5xx, a domain that does not exist or has a null MX, a refused From | Failed |
| 4xx, a host that cannot be reached, a blob not found | Tried again after 5, 15, 30 minutes, 1, 2, 4 then every 8 hours, failed after 4 days |

A temporary answer moves on to the next MX host, a permanent one stops. Each
recipient keeps the last answer. Messages that wait for nothing are deleted a
week after they arrived. Delivery status notifications (kind 7679) are not sent
yet.

Receivers check SPF against the server's address, through `include:SPF_INCLUDE`
in the domain's record, and many check that the address resolves back to
`MX_HOST`. So `SPF_INCLUDE` has to list the address the server sends from, and
its PTR record has to name `MX_HOST`.

## Configuration

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | | Postgres connection string |
| `MX_HOST` | yes | | SMTP host that connected domains point their MX at, and the name the server greets with when it sends. The server's relay and Blossom server answer at `nostr.MX_HOST` |
| `SPF_INCLUDE` | yes | | Domain whose SPF record lists the address the server sends from |
| `PUBLIC_IPV4` | yes | | IPv4 address that connected domains point their A record at, so that their HTTPS reaches this server |
| `ADMIN_PUBKEYS` | no | nobody | Comma-separated npubs or hex public keys allowed to call the [admin routes](#admin), which also receive [abuse reports](#abuse-reports) |
| `DKIM_SELECTOR` | no | `nostrmail` | Selector given to new claims; existing claims keep theirs |
| `DNS_SERVERS` | no | system resolver | Comma-separated IP addresses used for the record checks and for SPF, DKIM and DMARC |
| `PORT` | no | `3000` | HTTP port |
| `SMTP_PORT` | no | `2525` | SMTP port that receives mail for the connected domains |
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
