-- noon-wv8.3.2. An event handed back (Gitea away, the document's room read-only) was claimable again at once: the
-- oldest, it was taken every second tick after tick, every event behind it on every branch waited, and the mirror
-- was fetched each time. A hand-back now says when to look again, and the claim passes the event by until then.
alter table git_events add column not_before timestamptz;
