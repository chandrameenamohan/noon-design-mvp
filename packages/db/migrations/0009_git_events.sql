-- E5.3a: the git peer's inbox. A row says "this branch of the repo now points at this commit". Rows come
-- through two doors: Gitea's push webhook (the api) and the git peer's own reconcile of its mirror, because
-- Gitea never retries a failed delivery (SPEC §2a). Not tenant data: the repo is the stack's one seed repo.
create table git_events (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null check (ref ~ '^refs/heads/[A-Za-z0-9._/-]{1,200}$'),
  before_sha  text not null check (before_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  after_sha   text not null check (after_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- X-Gitea-Delivery; null when the reconcile found the commit. The same delivery twice is one row.
  delivery_id text unique check (length(delivery_id) between 1 and 100),
  status      text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  created_at  timestamptz not null default now(),
  finished_at timestamptz,
  check ((finished_at is not null) = (status in ('done', 'failed'))),
  -- The two doors meet here: whichever records a commit on a branch first wins, the other finds it taken.
  -- The database decides, not a "look, then insert" that two doors at the same instant would both pass.
  unique (ref, after_sha)
);
-- The git peer asks "what is waiting?" every second; a partial index keeps that cheap however many are done.
create index git_events_pending on git_events (created_at) where status = 'pending';

-- One flag: "a document was opened, reconcile soon". Requests coalesce: the peer clears it as it starts a
-- reconcile, so a burst of opens costs one fetch, and an open during a reconcile sets it again.
create table git_reconcile (
  id        boolean primary key default true check (id),
  requested boolean not null default true
);
insert into git_reconcile default values;
