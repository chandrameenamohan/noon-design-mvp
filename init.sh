#!/bin/sh
# Boots the dev environment and proves it works. Safe to run again.
set -eu
cd "$(dirname "$0")"

# Docker Desktop does not always put its CLI on PATH.
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
command -v docker >/dev/null 2>&1 || { echo "FAIL: docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "FAIL: Docker is not running"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "FAIL: pnpm not found (run: corepack enable pnpm)"; exit 1; }

pnpm install --frozen-lockfile
pnpm exec playwright install chromium
# bd points core.hooksPath at .beads/hooks and appends its own section to our hook,
# so install into whichever path git really uses, and never clobber bd's section.
hook="$(git rev-parse --git-path hooks)/pre-commit"
grep -q "make -s check" "$hook" 2>/dev/null || install -m 755 scripts/pre-commit "$hook"
grep -q "make -s check" "$hook" || { echo "FAIL: the pre-commit gate is not installed at $hook"; exit 1; }

# Local secrets: random, generated once, kept in the git-ignored .env that compose reads by itself.
# Hex only, so a value can sit inside a postgres:// URL without escaping.
touch .env
for name in POSTGRES_PASSWORD APP_DB_PASSWORD SESSION_TOKEN_SECRET REDIS_PASSWORD; do
  grep -q "^$name=" .env || printf '%s=%s\n' "$name" "$(openssl rand -hex 24)" >> .env
done
. ./.env

docker compose up -d --wait postgres redis
# POSTGRES_PASSWORD only applies when the data volume is first created. Setting it here as well keeps an
# existing volume (and one created with an older password) in step with .env. Local socket, no password needed.
docker compose exec -T postgres psql -U noon -d noon -qc "alter role noon password '$POSTGRES_PASSWORD'" >/dev/null
# The per-document preview sandbox (epic 4), BEFORE the worker that starts it. Minutes on a first run:
# it installs the sample app's dependencies.
docker build --quiet --tag noon-sandbox:dev --file apps/worker/sandbox/Dockerfile seed/sample-app >/dev/null
docker compose up -d --build --wait api sync worker worker-sandbox

# Smoke test: the database answers a real query.
answer=$(docker compose exec -T postgres psql -U noon -d noon -tAc "select 1")
[ "$answer" = "1" ] || { echo "FAIL: postgres smoke query returned '$answer'"; exit 1; }
# Smoke test: the api answers over real HTTP with the contract's shape.
health=$(curl -fsS "http://localhost:${API_PORT:-3000}/health")
[ "$health" = '{"status":"ok","service":"api"}' ] || { echo "FAIL: api /health returned '$health'"; exit 1; }
# Smoke test: a real write and read through the api, which reaches Postgres as the limited role.
api="http://localhost:${API_PORT:-3000}"
me='x-dev-user: init-smoke@example.com'
org=$(curl -fsS -X POST "$api/orgs" -H "$me" -H 'content-type: application/json' -d '{"name":"init.sh smoke"}')
org_id=$(printf '%s' "$org" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$org_id" ] || { echo "FAIL: POST /orgs returned '$org'"; exit 1; }
[ "$(curl -fsS -H "$me" "$api/orgs/$org_id")" = "$org" ] || { echo "FAIL: GET /orgs/$org_id did not return the created org"; exit 1; }
super=$(docker compose exec -T postgres psql -U noon -d noon -tAc "select rolsuper from pg_roles where rolname = 'noon_app'")
[ "$super" = "f" ] || { echo "FAIL: the app role is missing or is a superuser ('$super')"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$api/orgs/$org_id")" = "401" ] || { echo "FAIL: a request without an identity was not refused"; exit 1; }
# The whole live-editing path, with no test helpers: the api mints a session, a real WebSocket opens
# against the sync server with that token, sends one op and is told it became seq 1.
API_URL="$api" node scripts/smoke-sync.ts || { echo "FAIL: live-editing smoke test"; exit 1; }
# Epic 3: a run goes api -> Postgres -> Redis -> worker -> Postgres and is read back through the api.
# ANY terminal status proves that path. Whether the model did well is not this script's business: with no
# CLAUDE_CODE_OAUTH_TOKEN in .env the run ends as failed/token_missing, which is the right answer.
ws_id=$(curl -fsS -X POST "$api/orgs/$org_id/workspaces" -H "$me" -H 'content-type: application/json' -d '{"name":"smoke"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
doc_id=$(curl -fsS -X POST "$api/orgs/$org_id/workspaces/$ws_id/documents" -H "$me" -H 'content-type: application/json' -d '{"title":"smoke"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
run_id=$(curl -fsS -X POST "$api/documents/$doc_id/runs" -H "$me" -H 'content-type: application/json' -d '{"instruction":"This is a smoke test. Change nothing. Reply with the word done."}' | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
[ -n "$run_id" ] || { echo "FAIL: POST /documents/$doc_id/runs did not return a run"; exit 1; }
status=""
for _ in $(seq 1 180); do
  status=$(curl -fsS -H "$me" "$api/documents/$doc_id/runs/$run_id" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  case "$status" in succeeded|failed|cancelled) break ;; esac
  sleep 0.5
done
case "$status" in
  succeeded|cancelled) ;;
  failed)
    # WHY it failed decides: the provider or the credential is not this script's business, a broken
    # environment is (the SDK's binary missing from the image, sync unreachable from the worker, ...).
    reason=$(curl -fsS -H "$me" "$api/documents/$doc_id/runs/$run_id" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
    case "$reason" in
      token_missing|token_invalid|rate_limited|provider_unavailable|account_problem|timed_out|too_many_steps) status="failed ($reason: the credential or the provider, not this environment)" ;;
      *) echo "FAIL: the AI run failed as '$reason': that is this environment, not the model"; exit 1 ;;
    esac ;;
  # A slow provider must not fail the bootstrap: the run was accepted and claimed, which is what this checks.
  running) status="still running after 90 s (a slow provider; not a failure of this environment)" ;;
  *) echo "FAIL: the run is still '$status' after 90 s: the worker never claimed it (is it up?)"; exit 1 ;;
esac
echo "AI run smoke: $status"
docker compose exec -T postgres psql -U noon -d noon -qc "delete from orgs where name = 'init.sh smoke'; delete from users where email = 'init-smoke@example.com'" >/dev/null # leave nothing behind
echo "PASS: dev environment is up (api writes and reads through a non-superuser role, hook installed)"
