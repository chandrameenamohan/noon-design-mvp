-- F10: a user asks for a run to stop. A queued run is ended here and now; a running one is ended by
-- the worker that holds it, which looks at this column once a second (within 3 s, says the spec).
alter table jobs add column cancel_requested_at timestamptz;
