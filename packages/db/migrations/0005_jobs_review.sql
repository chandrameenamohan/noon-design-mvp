-- From the E3.1 review.
-- A failure reason is a NAME (token_missing, rate_limited, internal): the user reads it, so it can
-- never be an error message, which may carry a path, a request id or a piece of someone's prompt.
alter table jobs drop constraint jobs_error_check;
alter table jobs add constraint jobs_error_is_a_name check (error ~ '^[a-z][a-z0-9_]{0,63}$');

-- One unfinished AI run per document. Two agents rewriting one tree at once help nobody, and from
-- E3.2 every run is a paid model call: without this, a loop of POSTs is a bill and a queue that
-- starves every other org. Per-org limits and the 429 are F31 (E9); this is the floor under them.
create unique index jobs_one_unfinished_run_per_document on jobs (document_id) where queue = 'ai' and status in ('queued', 'running');
