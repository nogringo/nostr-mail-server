-- The admins and the owner of the domain each delete a report for themselves:
-- the row goes once nobody reads it any more.
alter table abuse_reports
  add column admin_deleted_at timestamptz,
  add column owner_deleted_at timestamptz;
