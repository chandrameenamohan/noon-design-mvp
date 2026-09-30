-- E9.2a (F28): a worker killed mid-job (kill -9, OOM, a lost host) says nothing, and its row stays `running`:
-- for an AI run that blocks the document's next run for ever (one unfinished run per document), for a sandbox
-- job it blocks the preview and keeps the container from being reaped. So a running job proves it is alive:
-- its worker writes heartbeat_at every second, and a sweep puts a job whose heartbeat went stale back in the
-- queue. `attempts` counts claims: it bounds the retries (a job that kills its worker every time must end),
-- and it FENCES a worker that was only slow: its heartbeat and its finish name the attempt they claimed,
-- and a newer claim makes both write nothing.
alter table jobs add column heartbeat_at timestamptz;
alter table jobs add column attempts integer not null default 0 check (attempts >= 0);
-- The sweep asks "which running jobs went silent?" every few seconds; only running rows are in this index.
create index jobs_running on jobs (heartbeat_at) where status = 'running';
