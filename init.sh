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

docker compose up -d --build --wait postgres api

# Smoke test: the database answers a real query.
answer=$(docker compose exec -T postgres psql -U noon -d noon -tAc "select 1")
[ "$answer" = "1" ] || { echo "FAIL: postgres smoke query returned '$answer'"; exit 1; }
# Smoke test: the api answers over real HTTP with the contract's shape.
health=$(curl -fsS "http://localhost:${API_PORT:-3000}/health")
[ "$health" = '{"status":"ok","service":"api"}' ] || { echo "FAIL: api /health returned '$health'"; exit 1; }
# Smoke test: a real write and read through the api, which reaches Postgres as the limited role.
api="http://localhost:${API_PORT:-3000}"
org=$(curl -fsS -X POST "$api/orgs" -H 'content-type: application/json' -d '{"name":"init.sh smoke"}')
org_id=$(printf '%s' "$org" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$org_id" ] || { echo "FAIL: POST /orgs returned '$org'"; exit 1; }
[ "$(curl -fsS "$api/orgs/$org_id")" = "$org" ] || { echo "FAIL: GET /orgs/$org_id did not return the created org"; exit 1; }
super=$(docker compose exec -T postgres psql -U noon -d noon -tAc "select rolsuper from pg_roles where rolname = 'noon_app'")
[ "$super" = "f" ] || { echo "FAIL: the app role is missing or is a superuser ('$super')"; exit 1; }
echo "PASS: dev environment is up (api writes and reads through a non-superuser role, hook installed)"
