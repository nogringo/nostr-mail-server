-- A private address receives and sends like the others, but NIP-05 does not
-- show the pubkey it reaches.
alter table addresses add column private boolean not null default false;
