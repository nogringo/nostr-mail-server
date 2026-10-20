-- Each claim gets its own Nostr key, served as _smtp@<domain>: clients wrap the
-- mail they send from the domain to it.
alter table domains
  add column bridge_pubkey text not null,
  add column bridge_private_key text not null,
  add constraint domains_bridge_pubkey_hex check (bridge_pubkey ~ '^[0-9a-f]{64}$'),
  add constraint domains_bridge_pubkey_unique unique (bridge_pubkey);
