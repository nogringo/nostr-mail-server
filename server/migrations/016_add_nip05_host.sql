-- Who serves the NIP-05 of the domain: this server, which its A record points
-- to, or the owner's own website, which then lists _smtp itself.
alter table domains
  add column nip05 text not null default 'server',
  add constraint domains_nip05 check (nip05 in ('server', 'owner'));

-- The A record check becomes the NIP-05 check.
update domains set checks = (checks - 'https') || jsonb_build_object('nip05', checks -> 'https') where checks ? 'https';
