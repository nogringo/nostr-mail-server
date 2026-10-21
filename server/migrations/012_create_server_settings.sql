-- What the admins change from the /admin page, in a single row.
create table server_settings (
  id boolean primary key default true check (id),
  -- Any key may claim a domain, not only the admins and the allowed keys.
  open_registration boolean not null default false
);

insert into server_settings default values;
