-- The document's tree and the sequence number it has reached, saved when the last peer leaves a room
-- (F8). From epic 6 the op journal and snapshots take over and this column becomes a cache.
alter table documents add column content jsonb;
alter table documents add column seq bigint not null default 0 check (seq >= 0);
