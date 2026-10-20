-- Mail the domains send: one row per gift wrap a sender addressed to a domain
-- key, kept a week so that a wrap seen again on a relay is not sent twice.
create table outbound_messages (
  wrap_id text primary key,
  bridge_pubkey text not null references domains (bridge_pubkey) on delete cascade,
  -- Kept while a recipient waits for delivery, null once none does.
  wrap jsonb,
  -- Why the wrap was not sent, when it was refused.
  refusal text,
  received_at timestamptz not null default now()
);

create index outbound_messages_received_at_idx on outbound_messages (received_at);

create table outbound_recipients (
  wrap_id text not null references outbound_messages (wrap_id) on delete cascade,
  address text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- The last answer of the recipient's server, or why it could not be reached.
  response text,
  primary key (wrap_id, address),
  constraint outbound_recipients_status check (status in ('pending', 'delivered', 'failed'))
);

create index outbound_recipients_due_idx on outbound_recipients (next_attempt_at) where status = 'pending';
