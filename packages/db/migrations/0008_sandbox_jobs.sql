-- E4.2b: the `sandbox` queue. An unfinished sandbox job is the RIGHT to start and keep a document's
-- sandbox: exactly one process may start a given document's container, or two starts race and remove
-- each other's (measured in E4.2a). So the rule lives here, where no code path can walk around it.
create unique index jobs_one_unfinished_sandbox_per_document on jobs (document_id) where queue = 'sandbox' and status in ('queued', 'running');
-- What a running job has to tell the rest of the system before it ends: for a sandbox job, the
-- address its preview answers on (the canvas puts it in an iframe). Validated by the writer.
alter table jobs add column output jsonb;
