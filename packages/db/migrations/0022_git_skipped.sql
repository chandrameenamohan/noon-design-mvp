-- noon-wv8.3.3. An event whose commit the branch's last applied commit already contains (an old push redelivered by
-- hand from Gitea after a later one folded it in; two peers finishing one branch's events out of order) is worked
-- on no more: applying it would set its pages back. It ends `skipped`, not `done`: the git peer diffs each push
-- from the branch's newest DONE event, and an old commit counted there would make the next push replay what was
-- already applied over the canvas.
alter table git_events drop constraint git_events_status_check;
alter table git_events add constraint git_events_status_check check (status in ('pending', 'running', 'done', 'failed', 'skipped'));
alter table git_events drop constraint git_events_check;
alter table git_events add constraint git_events_finished check ((finished_at is not null) = (status in ('done', 'failed', 'skipped')));
