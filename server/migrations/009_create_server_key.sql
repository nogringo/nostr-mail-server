-- The server's own Nostr key, created on its first start: it writes to the
-- admins the complaints no domain key is left for, about the server itself or
-- about a domain nobody owns any more.
create table server_key (
  id boolean primary key default true check (id),
  pubkey text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
