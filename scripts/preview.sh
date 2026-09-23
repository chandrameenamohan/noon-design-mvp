#!/bin/sh
# Opens the live preview of a document, until E4.3 puts it in the canvas itself.
#   sh scripts/preview.sh                 # a new document, for you@example.com
#   sh scripts/preview.sh <document-id>   # an existing one (copy the id from the canvas's ?doc=)
# Needs the stack up (./init.sh) and the canvas running (pnpm --filter @noon/web dev).
# ponytail: inserts the sandbox job with psql; E4.3 replaces this with an api route.
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
api="http://localhost:${API_PORT:-3000}"
user="${PREVIEW_USER:-you@example.com}"
me="x-dev-user: $user"
psql() { docker compose exec -T postgres psql -U noon -d noon -tAc "$1"; }
id() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }

doc="${1:-}"
if [ -z "$doc" ]; then
  org=$(curl -fsS -X POST "$api/orgs" -H "$me" -H 'content-type: application/json' -d '{"name":"Preview demo"}' | id)
  ws=$(curl -fsS -X POST "$api/orgs/$org/workspaces" -H "$me" -H 'content-type: application/json' -d '{"name":"Demo"}' | id)
  doc=$(curl -fsS -X POST "$api/orgs/$org/workspaces/$ws/documents" -H "$me" -H 'content-type: application/json' -d '{"title":"Checkout"}' | id)
fi
case "$doc" in *[!0-9a-f-]*|"") echo "not a document id: $doc"; exit 1;; esac

# The job IS the right to run this document's sandbox; one unfinished per document (a unique index).
job=$(psql "insert into jobs (org_id, document_id, queue, input, created_by)
  select d.org_id, d.id, 'sandbox', '{}', m.user_id from documents d
  join memberships m on m.org_id = d.org_id join users u on u.id = m.user_id
  where d.id = '$doc' and u.email = '$user' on conflict do nothing returning id" | head -1)
[ -n "$job" ] || job=$(psql "select id from jobs where document_id = '$doc' and queue = 'sandbox' and status in ('queued','running')")
[ -n "$job" ] || { echo "no such document for $user (set PREVIEW_USER to its owner)"; exit 1; }

printf 'starting the sandbox'
for _ in $(seq 1 120); do
  state=$(psql "select status || ' ' || coalesce(output->>'url', '') from jobs where id = '$job'")
  case "$state" in "running http"*) break;; failed*|succeeded*|cancelled*) echo; echo "job ended: $state"; exit 1;; esac
  printf '.'; sleep 0.5
done
echo
echo "canvas:  http://localhost:5173/?doc=$doc&user=$user"
echo "preview: ${state#running }"
echo "Open both. Edit on the canvas; the preview follows within 3 s. It stops following a minute after the canvas is closed."
