-- Domains an admin took out of service, whichever key claims them: the server
-- neither receives, sends nor serves NIP-05 for them, and no new claim is made.
create table suspended_domains (
  domain text primary key,
  suspended_at timestamptz not null default now(),
  constraint suspended_domains_lowercase check (domain = lower(domain))
);
