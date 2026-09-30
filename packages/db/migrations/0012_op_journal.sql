-- E6.1a (F18): every op the room accepted, written BEFORE anyone hears of it. Append-only: rows are never
-- updated. Two unique keys, told apart by NAME when an insert breaks one (learning-tests/postgres):
--   op_journal_seq: one op per number. Broken = a second writer is numbering this document: refuse.
--   op_journal_op:  one row per sender's opId. Broken = a resend the room had forgotten: answer with the
--                   original row. Keyed by the SENDER, as the room's own memory is: every broadcast shows
--                   every opId to every peer, so another peer's opId is not a resend.
create table op_journal (
  document_id uuid not null,
  org_id      uuid not null,
  seq         bigint not null check (seq >= 1),
  op_id       uuid not null,
  actor_kind  text not null check (actor_kind in ('user', 'agent', 'git')),
  actor_id    text not null check (length(actor_id) between 1 and 200),
  run_id      text check (length(run_id) between 1 and 200),
  op          jsonb not null,
  created_at  timestamptz not null default now(),
  constraint op_journal_seq primary key (document_id, seq),
  constraint op_journal_op unique (document_id, actor_id, op_id),
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade
);
-- Keystone 4: a node id that was ever added is never added again. The room asks this before each add.
create index op_journal_added on op_journal (document_id, (op ->> 'nodeId')) where op ->> 'type' = 'add_node';
