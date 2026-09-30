-- E5.4 (F16b): the newest push to a document's branch that the git peer refused, which the canvas shows as a
-- banner. One row per document: a later refused push replaces it, a later applied one removes it. Nothing
-- else is kept: the document itself was not touched, and git holds the commit.
create table document_conflicts (
  document_id uuid primary key references documents (id) on delete cascade,
  commit_sha  text not null check (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  file        text not null check (length(file) between 1 and 300),
  reason      text not null check (reason ~ '^[a-z_]{1,40}$'),
  detail      text not null check (length(detail) <= 300),
  created_at  timestamptz not null default now()
);
