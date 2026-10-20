-- Addresses declared by the verified owner of a domain. They belong to the
-- owner's claim and go away with it, including when another key takes over.
create table addresses (
  domain text not null,
  local_part text not null,
  pubkey text not null,
  owner_pubkey text not null,
  created_at timestamptz not null default now(),
  primary key (domain, local_part),
  foreign key (domain, owner_pubkey) references domains (domain, pubkey) on delete cascade,
  constraint addresses_local_part check (local_part ~ '^[a-z0-9_-]+(\.[a-z0-9_-]+)*$' and length(local_part) <= 64),
  constraint addresses_pubkey_hex check (pubkey ~ '^[0-9a-f]{64}$')
);
