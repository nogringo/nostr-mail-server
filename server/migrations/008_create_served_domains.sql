-- Every domain a claim was ever verified on, kept once the claim is released:
-- complaints about the mail it sent can still come to its abuse@.
create table served_domains (
  domain text primary key,
  first_verified_at timestamptz not null default now(),
  constraint served_domains_lowercase check (domain = lower(domain))
);

insert into served_domains (domain, first_verified_at)
select domain, min(verified_at) from domains where verified_at is not null group by domain;
