-- "Which orgs is this user in?" (GET /orgs) filters memberships by user_id alone. The primary key is
-- (org_id, user_id), which cannot serve that lookup, so without this index every page load scans the
-- whole table. It also backs the users foreign key when a user is deleted (epic 8).
create index memberships_user_id on memberships (user_id);
