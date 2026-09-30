-- E9.1 (F27): "start AI run" and "ship" may be retried. The client sends an Idempotency-Key with the press; a retry
-- with the same key is answered with the job the first one made (or joined), never a second job. The PRIMARY KEY is
-- the check, not a look-then-insert: of two requests at the same moment, the second waits on the first's row and
-- then reads it. Scoped to (org, user): a key can only ever name a job of the caller's own org, made by the caller.
-- `request` is what was asked (queue, document, input): the same key with a different request is refused (422).
-- A key lives 24 hours (as Stripe's do): each claim first forgets that user's older keys, so a key may be used again
-- after that. It also goes with its job, its user and its org.
create table idempotency_keys (
  org_id     uuid not null references orgs (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  key        text not null check (key ~ '^[!-~]{1,255}$'),
  request    jsonb not null,
  -- Null only inside the claiming transaction (the key is claimed BEFORE the job is made); never seen committed.
  job_id     uuid references jobs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id, key)
);
-- Back the cascades from jobs and users.
create index idempotency_keys_job on idempotency_keys (job_id);
create index idempotency_keys_user on idempotency_keys (user_id);
