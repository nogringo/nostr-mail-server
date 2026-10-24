-- The blobs clients upload to the server's Blossom endpoint for the large mail
-- they send. One goes once no email waits for it: soon after the email holding
-- it is sent, or a day after its upload when no email took it.
create table blobs (
  sha256 text primary key,
  data bytea not null,
  size integer not null,
  -- The key of the upload's authorization, often a throwaway one.
  uploader text not null,
  uploaded_at timestamptz not null default now(),
  constraint blobs_sha256_hex check (sha256 ~ '^[0-9a-f]{64}$')
);

create index blobs_uploaded_at_idx on blobs (uploaded_at);

alter table outbound_messages add column blob_sha256 text;

create index outbound_messages_blob_sha256_idx on outbound_messages (blob_sha256) where blob_sha256 is not null;

-- The Blossom server the domain keys announce (kind 10063), the server's own:
-- kept, like domain_relays, to publish their lists again when it changes.
alter table server_settings add column domain_blossom_server text;

-- Uploads stop once the blobs the server holds reach this size together, so
-- that no one fills its disk with throwaway keys.
alter table server_settings add column max_blob_storage_bytes bigint not null default 1073741824;
