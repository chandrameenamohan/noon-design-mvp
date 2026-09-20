-- Long-running work (SPEC §2.9): this table is the TRUTH about a job; Redis only carries "go and
-- look at job X" to a worker and can be lost at any time. An AI run is a job on the `ai` queue.
alter table documents add constraint documents_id_org_id unique (id, org_id); -- target for the composite foreign key below

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs (id) on delete cascade,
  document_id uuid not null,
  queue       text not null check (queue in ('ai', 'git', 'ship', 'sandbox')),
  status      text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input       jsonb not null,
  -- A short named reason, never a stack trace or a database message: the user reads this.
  error       text check (length(error) between 1 and 200),
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  -- The database, not the application, guarantees a job's org matches its document's org.
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade,
  -- A terminal status has an end time and only a failure has a reason. No path can store a half-finished row.
  check ((finished_at is not null) = (status in ('succeeded', 'failed', 'cancelled'))),
  check ((error is not null) = (status = 'failed'))
);
create index jobs_document on jobs (org_id, document_id, created_at);
-- The worker's sweep asks "what is still waiting?"; a partial index keeps that cheap however many jobs have finished.
create index jobs_queued on jobs (created_at) where status = 'queued';
