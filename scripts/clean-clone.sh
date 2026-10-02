#!/bin/sh
# Proves F1: a fresh clone boots and passes the gate. Clones the committed HEAD into a temp dir,
# under its own compose project and ports so it cannot lean on (or disturb) the dev environment.
# Arguments, if any, are a command run in the clone afterwards, on that same stack: `make scenario` (SPEC §8).
# ponytail: the pnpm store, Playwright browsers and Docker layer cache are shared with the host,
# so this proves "nothing uncommitted is needed", not "works with an empty machine cache".
set -u
src=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
# Every port docker-compose.yml publishes: one left at its default collides with the dev stack's, and compose refuses to start.
export COMPOSE_PROJECT_NAME=noon-clean PG_PORT=55432 API_PORT=53000 SYNC_PORT=53001 SYNC_2_PORT=53003 REDIS_PORT=56379 SANDBOX_PROXY_PORT=20200 GITEA_PORT=53002 MINIO_PORT=59005 TOXIPROXY_PORT=58474
# The e2e layer's own servers and sandbox pool (e2e/ports.ts): off the dev checkout's, so a `make e2e` there can run
# beside this one, and neither's teardown removes the other's sandboxes (noon-cs6.1.1). 53100: off the 3100 other projects hold.
export E2E_API_PORT=53100 E2E_WEB_PORT=55174 E2E_SYNC_PORT=53101 E2E_WORKER_PORT=53102 E2E_SYNC_2_PORT=53104 E2E_SANDBOX_PROXY_PORT=20300 E2E_SANDBOX_POOL=noon-clean-e2e
unset POSTGRES_PASSWORD APP_DB_PASSWORD SESSION_TOKEN_SECRET REDIS_PASSWORD GITEA_ADMIN_PASSWORD GITEA_WEBHOOK_SECRET GITEA_TOKEN GITEA_READ_TOKEN MINIO_PASSWORD # the clone must generate its own secrets
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

cleanup() {
  (cd "$tmp" && docker compose down -v --rmi local >/dev/null 2>&1)
  # What the clone's sandbox worker started through Docker itself, which compose does not know of: its sandboxes,
  # its proxy, and then their networks (each holds one of the daemon's few address pools).
  # The e2e layer's pool too, should its own teardown not have run.
  for pool in "$COMPOSE_PROJECT_NAME" "$E2E_SANDBOX_POOL"; do
    for label in "noon.sandbox=$pool" "noon.proxy-pool=$pool"; do
      docker ps --all --quiet --filter "label=$label" | xargs docker rm --force >/dev/null 2>&1
    done
    docker network ls --quiet --filter "label=noon.sandbox=$pool" | xargs docker network rm >/dev/null 2>&1
    # Said, not silent (noon-cs6.1.2): the next run's worker replaces a stale proxy without a word, so nothing else
    # would notice one left behind. The proxy is looked for by its NAME (sandbox.ts proxyName), not by the label the
    # removal above used, so a wrong label shows here; sandboxes and networks have only their label to go by.
    left=$( (docker ps --all --quiet --filter "name=^noon-sandbox-proxy-$pool\$"; docker ps --all --quiet --filter "label=noon.sandbox=$pool"; \
      docker network ls --quiet --filter "label=noon.sandbox=$pool") | wc -l | tr -d ' ')
    [ "$left" = 0 ] && echo "cleanup: pool $pool left nothing behind" || echo "WARN: cleanup left $left container(s)/network(s) of pool $pool behind"
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

git clone -q "$src" "$tmp" || { echo "FAIL: clone"; exit 1; }
cd "$tmp" || exit 1
./init.sh || { echo "FAIL: init.sh in a clean clone"; exit 1; }
make -s check || { echo "FAIL: make check in a clean clone"; exit 1; }
echo "PASS: clean clone boots and the gate is green"
[ $# -eq 0 ] || "$@" || { echo "FAIL: $* in a clean clone"; exit 1; }
