-- An address delivers its mail to every key it lists, and each of them sends
-- from it. NIP-05 shows a key only for an address with one.
alter table addresses add column pubkeys text[];
update addresses set pubkeys = array[pubkey];
alter table addresses
  alter column pubkeys set not null,
  drop column pubkey,
  add constraint addresses_pubkeys_hex check (
    cardinality(pubkeys) > 0 and array_to_string(pubkeys, ' ') ~ '^[0-9a-f]{64}( [0-9a-f]{64})*$'
  );

-- A null quota is no limit, as for the others.
alter table server_settings alter column quotas set default
  '{"addresses": null, "addressesPerHour": null, "pendingDomains": null, "recipientsPerDay": null, "keysPerAddress": null}';
update server_settings set quotas = quotas || '{"keysPerAddress": null}';
