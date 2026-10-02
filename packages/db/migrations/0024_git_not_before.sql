-- noon-wv8.3.2. An event handed back (Gitea away, the document's room read-only) was claimable again at once: the
-- oldest, it was taken every second tick after tick, every event behind it on every branch waited, and the mirror
-- was fetched each time. A hand-back now says when to look again, and the claim passes the event by until then.
-- Safe to run twice: a stack that applied it as 0023_git_not_before.sql runs it again under this name.
alter table git_events add column if not exists not_before timestamptz;
