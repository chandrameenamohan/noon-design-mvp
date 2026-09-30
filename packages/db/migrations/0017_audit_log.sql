-- E8.4 (F26): the org's audit trail. Append-only, and the DATABASE says so, twice: the app's login role is never
-- granted UPDATE, DELETE or TRUNCATE on it (provisionAppRole revokes them), and a trigger refuses them to anyone else
-- who connects, the owner included. Each row is written in the same statement (or transaction) as the action it
-- records, so an action cannot commit unaudited, nor an audit row for an action that rolled back.
--
-- No foreign keys at all, on purpose (the E1.2 review): `on delete cascade` from orgs would erase an org's trail
-- together with the org, and `on delete set null` from users is an UPDATE. So the actor's email is copied in as it
-- was at the time, and a row may name a user, a document or an org that no longer exists.
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  -- user: a person (actor_id); git: a push to a document's branch (its commit is in detail); system: a job or
  -- change with no person behind it (a run created by a script, a role changed from a test).
  actor_kind  text not null check (actor_kind in ('user', 'git', 'system')),
  actor_id    uuid,
  actor_email text check (length(actor_email) between 3 and 320),
  action      text not null check (action in ('signed_in', 'role_changed', 'share_granted', 'share_revoked', 'run_started', 'ship_started', 'push_rejected')),
  document_id uuid,
  -- Flat text values only (the reader parses them as such); capped, as an instruction alone may be 4000 characters.
  detail      jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 20000),
  created_at  timestamptz not null default now(),
  check ((actor_kind = 'user') = (actor_id is not null))
);
-- The audit view pages an org's rows newest first.
create index audit_log_org on audit_log (org_id, created_at, id);

create function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only: % refused', tg_op;
end
$$;
create trigger audit_log_no_change before update or delete on audit_log for each row execute function audit_log_append_only();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_append_only();
