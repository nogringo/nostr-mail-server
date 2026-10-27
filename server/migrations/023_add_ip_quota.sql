-- The addresses created from one IP address in an hour, counted in memory
-- only: no IP address is stored.
alter table server_settings alter column quotas set default
  '{"addresses": null, "addressesPerHour": null, "pendingDomains": null, "recipientsPerDay": null, "keysPerAddress": null, "addressesPerIpPerHour": null}';
update server_settings set quotas = quotas || '{"addressesPerIpPerHour": null}';
