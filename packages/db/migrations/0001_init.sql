-- Tenancy from day one (SPEC §2.10): every tenant-owned table carries org_id.
-- Two tables are deliberately not tenant-owned: orgs IS the tenant, and users are
-- global identities that join orgs through memberships (one person, many orgs).

create table orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique check (length(email) between 3 and 320),
  name       text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references orgs (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs (id) on delete cascade,
  name       text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, org_id) -- target for the composite foreign key below
);
create index workspaces_org_id on workspaces (org_id, created_at);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs (id) on delete cascade,
  workspace_id uuid not null,
  title        text not null check (length(title) between 1 and 200),
  created_at   timestamptz not null default now(),
  -- The database, not the application, guarantees a document's org matches its workspace's org.
  foreign key (workspace_id, org_id) references workspaces (id, org_id) on delete cascade
);
create index documents_workspace on documents (org_id, workspace_id, created_at);
