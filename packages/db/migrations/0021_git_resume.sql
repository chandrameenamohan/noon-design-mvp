-- noon-91u. A git peer killed mid-event (kill -9, OOM, a lost host) says nothing, and its git_events row stays
-- `running` for ever: the push never reaches the canvas. So, as 0019 did for jobs, a running event proves it is
-- alive: its peer writes heartbeat_at every few seconds, and a claim takes a running event whose heartbeat went
-- stale as readily as a pending one (resumed: push-ops is replay-safe, keyed by the commit in the journal).
-- `attempts` counts claims and FENCES a peer that was only slow: its heartbeat and its finish name the attempt they
-- claimed, and a newer claim makes both write nothing. `resumes` counts the stale takeovers alone, so an event that
-- kills its peer every time ends as failed; a hand-back (`pending`: Gitea away, the room read-only) is not one.
alter table git_events add column heartbeat_at timestamptz;
alter table git_events add column attempts integer not null default 0 check (attempts >= 0);
alter table git_events add column resumes integer not null default 0 check (resumes >= 0);
-- The claim asks "which running events went silent?" every tick; only running rows are in this index.
create index git_events_running on git_events (heartbeat_at) where status = 'running';

-- noon-91u. "Did Ship push this commit?" (the git peer skips Ship's own pushes, or it would diff them and undo a
-- canvas edit that raced the ship). jobs.output holds ONE commit, and a retried ship overwrote it (with the retry's
-- commit, or with null when the branch already held the page): the first attempt's push, if the git peer had not
-- handled it yet, was diffed. Every commit a ship made is kept here, written BEFORE it is pushed, never removed
-- while its job exists. The key is the commit: the same commit recorded twice is one row.
create table ship_commits (
  commit_sha text primary key check (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  job_id     uuid not null references jobs (id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into ship_commits (commit_sha, job_id)
  select output ->> 'commit', id from jobs
  where queue = 'ship' and output ->> 'commit' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  on conflict do nothing;
-- Its only reader was shippedCommit, which asks ship_commits now.
drop index jobs_ship_commit;
