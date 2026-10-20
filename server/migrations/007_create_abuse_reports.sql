-- Mail sent to abuse@ of a domain, kept for its owner and the admins of the
-- server to read on the site, whatever happened to it on Nostr.
create table abuse_reports (
  id integer generated always as identity primary key,
  domain text not null,
  -- The SHA-256 of the message as received: a delivery the sender retries is kept once.
  email_id text not null,
  mail_from text not null,
  -- The decoded From and Subject fields, to list the reports without reading the messages.
  header_from text not null,
  subject text not null,
  -- The MIME as delivered, with the trace fields the server added on top.
  message bytea not null,
  received_at timestamptz not null default now(),
  unique (domain, email_id)
);

create index abuse_reports_domain_received_at_idx on abuse_reports (domain, received_at);
