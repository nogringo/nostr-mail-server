-- The keys an admin lets connect domains, besides the admins themselves. Unless
-- an admin opens registration, no other key can make a new claim.
create table allowed_keys (
  pubkey text primary key,
  allowed_at timestamptz not null default now(),
  constraint allowed_keys_pubkey_hex check (pubkey ~ '^[0-9a-f]{64}$')
);
