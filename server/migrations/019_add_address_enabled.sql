-- A disabled address takes its mail and drops it, without telling the sender,
-- until it is enabled again. It still sends.
alter table addresses add column enabled boolean not null default true;
