-- F12: what a run cost, against the org. Its OWN table, not columns on jobs: a job goes when its
-- document goes (cascade), and what was spent must not disappear with it. So the links to the job,
-- the document and the user are loose on purpose; only the org is a hard owner.
create table usage (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs (id) on delete cascade,
  job_id             uuid unique references jobs (id) on delete set null, -- unique: a job is billed once, however often its message arrives
  document_id        uuid, -- no foreign key: it may name a document that no longer exists
  user_id            uuid references users (id) on delete set null,
  kind               text not null check (kind in ('ai_run')),
  model              text not null check (length(model) between 1 and 100),
  input_tokens       bigint not null check (input_tokens >= 0),
  output_tokens      bigint not null check (output_tokens >= 0),
  cache_read_tokens  bigint not null check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null check (cache_write_tokens >= 0),
  -- The provider's ESTIMATE in US dollars (under a subscription nothing is charged per run). numeric, not
  -- float: sums of money must not drift.
  cost_usd           numeric(12, 6) not null check (cost_usd >= 0),
  created_at         timestamptz not null default now()
);
create index usage_org on usage (org_id, created_at, id);
