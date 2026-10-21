-- Settings that came from environment variables, changed from the /admin page
-- since. The defaults are the values the variables had.
alter table server_settings
  -- Largest message received over SMTP, and largest blob read to send one.
  add column max_message_bytes integer not null default 26214400,
  -- Given to new claims for their large mail, and used by the server key.
  add column blossom_servers text[] not null
    default '{https://blossom.nmail.li,https://blossom.yakihonne.com,https://blossom.ditto.pub}',
  -- The NIP-65 relays Nostr Mail recommends, announced by every domain key.
  add column domain_relays text[] not null
    default '{wss://relay.nmail.li/,wss://relay.ditto.pub/,wss://nos.lol/,wss://relay.primal.net/}',
  -- Where the lists of other keys are looked up.
  add column indexer_relays text[] not null
    default '{wss://purplepag.es/,wss://user.kindpag.es/,wss://indexer.coracle.social/}',
  -- Domain relays taken off the list, by the date the outbox stops listening to
  -- them: clients that have not seen the change still send there.
  add column retired_domain_relays jsonb not null default '{}';
