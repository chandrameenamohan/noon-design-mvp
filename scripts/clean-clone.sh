#!/bin/sh
# Proves F1: a fresh clone boots and passes the gate. Clones the committed HEAD into a temp dir,
# under its own compose project and ports so it cannot lean on (or disturb) the dev environment.
# ponytail: the pnpm store, Playwright browsers and Docker layer cache are shared with the host,
# so this proves "nothing uncommitted is needed", not "works with an empty machine cache".
set -u
src=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
export COMPOSE_PROJECT_NAME=noon-clean PG_PORT=55432 API_PORT=53000 SYNC_PORT=53001 REDIS_PORT=56379 SANDBOX_PROXY_PORT=20200
unset POSTGRES_PASSWORD APP_DB_PASSWORD SESSION_TOKEN_SECRET REDIS_PASSWORD # the clone must generate its own secrets
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

cleanup() {
  (cd "$tmp" && docker compose down -v --rmi local >/dev/null 2>&1)
  rm -rf "$tmp"
}
trap cleanup EXIT

git clone -q "$src" "$tmp" || { echo "FAIL: clone"; exit 1; }
cd "$tmp" || exit 1
./init.sh || { echo "FAIL: init.sh in a clean clone"; exit 1; }
make -s check || { echo "FAIL: make check in a clean clone"; exit 1; }
echo "PASS: clean clone boots and the gate is green"
