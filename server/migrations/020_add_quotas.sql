-- What a key may do, set from the /admin page. A null quota is no limit, and
-- the admins have none.
alter table server_settings
  add column quotas jsonb not null
    default '{"addresses": null, "addressesPerHour": null, "pendingDomains": null, "recipientsPerDay": null}';

-- Quotas an admin gives one key instead of the server's: a quota left out is
-- the server's, a null one is no limit.
create table key_quotas (
  pubkey text primary key,
  quotas jsonb not null,
  updated_at timestamptz not null default now(),
  constraint key_quotas_pubkey_hex check (pubkey ~ '^[0-9a-f]{64}$')
);

-- What the quotas over a period count: the addresses a key creates, and the
-- recipients a domain sends to. Deleting an address or a domain gives nothing
-- back. Rows older than a day are pruned.
create table quota_usage (
  quota text not null,
  subject text not null,
  amount integer not null,
  used_at timestamptz not null default now(),
  constraint quota_usage_quota check (quota in ('addressesPerHour', 'recipientsPerDay'))
);

create index quota_usage_subject_idx on quota_usage (quota, subject, used_at);
