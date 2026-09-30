-- E7.3 (F22): the fence. A sync node that took a room's lease CLAIMS the document here before it reads the
-- journal: fence_token rises to its lease token (never back down), fence_claim becomes the id of that one
-- opening. The journal append inserts only while fence_claim is still the appender's, in the SAME statement
-- that locks this row (FOR UPDATE): an owner frozen past its lease that runs again cannot add a row after a
-- newer owner's claim, and a row it added before the claim is in the journal the newer owner then replays.
-- The token is kept here, not only in Redis: a flushed Redis restarts its counter at 1, so the next acquire
-- is seeded from fence_token, and tokens keep rising across the flush.
alter table documents
  add column fence_token bigint not null default 0 check (fence_token >= 0),
  add column fence_claim uuid;
