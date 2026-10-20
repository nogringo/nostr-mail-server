-- One row per (domain, pubkey) claim. Several keys may claim the same domain
-- until one of them proves it controls the DNS.
create table domains (
  domain text not null,
  pubkey text not null,
  verification_token text not null,
  dkim_selector text not null,
  dkim_public_key text not null,
  dkim_private_key text not null,
  checks jsonb,
  checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (domain, pubkey),
  constraint domains_lowercase check (domain = lower(domain)),
  constraint domains_pubkey_hex check (pubkey ~ '^[0-9a-f]{64}$')
);

create unique index domains_one_verified_owner on domains (domain) where verified_at is not null;
create index domains_pubkey_idx on domains (pubkey);
