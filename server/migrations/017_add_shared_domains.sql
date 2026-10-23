-- On a shared domain, any key creates addresses for itself. An address is
-- managed by the key that created it: the owner, or the key it delivers to.
alter table domains add column shared boolean not null default false;

alter table addresses add column created_by text;
update addresses set created_by = owner_pubkey;
alter table addresses
  alter column created_by set not null,
  add constraint addresses_created_by_hex check (created_by ~ '^[0-9a-f]{64}$');

create index addresses_created_by on addresses (created_by);
