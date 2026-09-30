-- E9.5 (F31): rate limits, counted HERE so every api instance shares one count (a counter in each process would let
-- N instances allow N times the limit). One row per key (`ai_run:<org id>`, and E9.6's per user and per address keys):
-- the fixed window it is counting (seconds since the epoch divided by the window's length) and the hits in it. A hit
-- is ONE upsert, so two at the same moment take turns on the row, and a hit made inside a transaction that rolls back
-- (a run refused as busy, or over the limit) is not counted. No foreign key: a key names whatever it limits.
create table rate_limits (
  key  text primary key check (length(key) between 1 and 200),
  win  bigint not null,
  hits integer not null check (hits >= 1)
);

-- F31: the usage view sums an org's usage per user.
create index usage_org_user on usage (org_id, user_id);
