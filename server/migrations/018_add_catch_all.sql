-- A catch-all domain creates the address the first time mail reaches one it
-- does not know, so its local part can be any dot-atom, like alice+shop.
alter table domains add column catch_all boolean not null default false;

alter table addresses drop constraint addresses_local_part;
alter table addresses add constraint addresses_local_part check (
  local_part ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*$' and length(local_part) <= 64
);

-- A deleted address waits here until the owner allows it again: nothing
-- creates it meanwhile, by hand or through the catch-all.
create table deleted_addresses (
  domain text not null,
  local_part text not null,
  owner_pubkey text not null,
  deleted_at timestamptz not null default now(),
  primary key (domain, local_part),
  foreign key (domain, owner_pubkey) references domains (domain, pubkey) on delete cascade
);
