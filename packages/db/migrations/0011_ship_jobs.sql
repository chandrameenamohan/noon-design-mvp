-- E5.5 (F17): the `ship` queue. Presses of Ship coalesce into the document's WAITING ship: it has not read the
-- document yet, so it will ship every edit made before it starts. A press while one RUNS queues the next one,
-- which reads the document afresh: pressing again after an edit always ships that edit. Two ships running for
-- one document are safe (the branch refuses a push that is not on top of it, and Gitea keeps one open pull
-- request per branch), so only the waiting one is unique, and the database decides, not a look-then-insert.
create unique index jobs_one_queued_ship_per_document on jobs (document_id) where queue = 'ship' and status = 'queued';
-- The git peer asks, for each push, "did Ship make this commit?" (jobs.output->>'commit').
create index jobs_ship_commit on jobs ((output ->> 'commit')) where queue = 'ship';
