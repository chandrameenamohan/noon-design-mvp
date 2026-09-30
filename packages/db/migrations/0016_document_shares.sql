-- E8.3 (F25): one document shared with a user outside its org, at editor or viewer (never owner: a share opens a
-- document, never the org). A table of its own, never rows in memberships: a share must not make anyone a member
-- (every org route, and GET /orgs's paging over orgs join memberships, stay exactly as they were).
-- Revoking deletes the row. The composite key ties the share to the document's org, and dies with the document.
create table document_shares (
  org_id      uuid not null,
  document_id uuid not null,
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('editor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (document_id, user_id),
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade
);
-- Backs the users foreign key when a user is deleted.
create index document_shares_user_id on document_shares (user_id);
