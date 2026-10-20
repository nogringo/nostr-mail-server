-- The owner may keep the domain key in their bunker (NIP-46): the server then
-- holds no private key for it, only how to reach the bunker.
alter table domains
  alter column bridge_private_key drop not null,
  add column bridge_bunker jsonb,
  add constraint domains_bridge_key_held check ((bridge_private_key is null) <> (bridge_bunker is null));
