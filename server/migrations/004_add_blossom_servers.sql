-- The Blossom servers that store a domain's large mail, published as the kind
-- 10063 of its key. Claims made before this migration start with none.
alter table domains add column blossom_servers text[] not null default '{}';
alter table domains alter column blossom_servers drop default;
