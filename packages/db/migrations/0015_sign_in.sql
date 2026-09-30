-- E8.1 (F23): sign up, sign in, sign out. Two tables of their own, never columns on users: a user created
-- before sign-in existed (the development header's) simply has no credential, and cannot sign in as anyone.

-- One password per user, stored only as a scrypt hash that names its own parameters, so they can be raised later
-- without a migration (a hash with the old ones still verifies).
create table credentials (
  user_id       uuid primary key references users (id) on delete cascade,
  password_hash text not null check (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  created_at    timestamptz not null default now()
);

-- A signed-in browser. The cookie holds 32 random bytes; this row holds only their SHA-256, so a read of the
-- table (a backup, a log of a query) hands nobody a live session. Signing out deletes the row: revoked at once.
create table auth_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  token_hash bytea not null unique check (length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > created_at)
);
create index auth_sessions_user on auth_sessions (user_id);
