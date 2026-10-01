#!/usr/bin/env bash
# The local Antithesis-style harness (SPEC §4a A1): the hermetic slice, a workload, and faults at the trust
# boundaries while the properties of antithesis/scratchbook/ are checked. This script is the local stand-in for
# Antithesis's fault injector: it holds Docker and toxiproxy; the driver container holds the workload and the judge.
#
#   ./run.sh up                 build the images, start the slice, make the world (first_setup)
#   ./run.sh baseline           the quiet workload, then ONE of each fault window  -> every property PASS, every guard hit
#   ./run.sh quiet              the test template's drivers and checks, no fault
#   ./run.sh <scenario>         one named scenario, then the checks:
#        store-unavailable      Postgres cut from the sync nodes (toxiproxy toggle)        -> read-only, held op lands once
#        store-slow [ms]        latency on every Postgres answer to the sync nodes          -> slower, nothing else (600; from about 1500
#                               an open outlasts the drivers' 20 s wait and the run cannot finish: reports/, finding P2)
#        sync-killed            `docker kill -9` of a room's owner under a burst            -> no loss, resends answered once
#        sync-paused            `docker pause` of the owner past its lease, an append in transit -> the zombie's append is fenced
#        worker-killed          `docker kill -9` of the AI worker mid-run                   -> the run resumes as attempt 2
#        worker-paused          `docker pause` of the AI worker past staleMs, then resumed  -> the stale attempt writes nothing
#        redis-wiped            FLUSHALL with jobs waiting and running, a room open         -> jobs rebuilt, one owner again
#        webhook-dropped        Gitea's delivery refused (toxiproxy toggle) at a push       -> the reconcile brings it to the canvas, once
#        worker-store-unavailable  Postgres cut from the api and the workers past staleMs   -> the run succeeds, each step once, as attempt 1 or (given away as stale) 2
#        upgrade-reset          refused upgrades reset by their client at a room's owner     -> the node does not notice
#        minio-unavailable [open]  MinIO cut, a snapshotted document reopened               -> edits refused as not loaded, or landed; opens once MinIO is back
#        minio-stalled [open]      MinIO accepts and never answers (timeout toxic), the same -> the same
#                                  (`open`: the fault comes while the room is still open, then its last peer leaves)
#   ./run.sh chaos [N]          N rounds: a random scenario each, checked and judged per round (default 6)
#   ./run.sh report [--require pass|guards|round]   PASS/FAIL per property, from the SDK's local output
#   ./run.sh no-internet        harness:no-internet: no route out of any container, no published port, no model credential
#   ./run.sh reset              undo every fault, forget the run's state (the world and the database stay)
#   ./run.sh down               stop the slice and remove its volumes
#
# Carried-over pitfalls (SPEC §4a), as they are handled here: a fault is opened BEFORE the workload or the system is
# slowed first; every fault is triggered off a line the scene prints, never a sleep; no `set -e` (a failing round
# must not end the run); a baseline is one pass, so `chaos N` repeats; container states are recorded BEFORE anything
# is started again (a restart hides a crash).
cd "$(dirname "$0")" || exit 1
HERE=$PWD
ROOT=$(cd ../.. && pwd)
RUN=$HERE/.run
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Its own compose project, with no published port: it cannot touch the dev stack, nor be touched by it.
export COMPOSE_PROJECT_NAME=noon-antithesis APP_TAG="${APP_TAG:-local}" DRIVER_TAG="${DRIVER_TAG:-local}"
[ -f "$RUN/gitea.env" ] && . "$RUN/gitea.env"
export GITEA_TOKEN="${GITEA_TOKEN:-}"
LEASE_TTL_MS="${LEASE_TTL_MS:-4000}"
APP_SERVICES="api sync sync-2 worker worker-git worker-ship"

say() { printf '%s\n' "$*"; }
dc() { docker compose -f "$HERE/docker-compose.yaml" --profile standby "$@"; }
tox() { dc exec -T toxiproxy /toxiproxy-cli "$@" >/dev/null; }
in_driver() { dc exec -T driver node -e "$1"; }
# Every proxy enabled, every toxic gone: toxiproxy's own reset.
tox_reset() { in_driver "fetch('http://toxiproxy:8474/reset',{method:'POST'}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
quiet_sdk() { grep -v "Failed to load libvoidstar"; }
sdk_file() { printf '/var/antithesis/sdk/%s.%s.%s.jsonl' "${1//:/-}" "$(date +%s)" "$RANDOM"; }

# One command of the test template, as Antithesis would run it: the file under /opt/antithesis/test/v1/noon.
drv() {
  dc exec -T -e ANTITHESIS_SDK_LOCAL_OUTPUT="$(sdk_file "$1")" driver "/opt/antithesis/test/v1/noon/$1" 2>&1 | quiet_sdk
  local code=${PIPESTATUS[0]}
  [ "$code" = 0 ] || unfinished "$1" "exit $code"
  return "$code"
}
# A command or a scene that could not do its work asserted nothing: that is never a PASS (the report cannot see it).
unfinished() { printf '%s %s (%s)\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$RUN/unfinished.log"; }
could_not_finish() {
  [ -s "$RUN/unfinished.log" ] || return 1
  say "could not finish (no verdict from these: the run is NOT a pass):"; sed 's/^/  /' "$RUN/unfinished.log"
}
# An app container found dead that no fault killed is a FAIL of the run, whatever the properties say.
found_dead() {
  [ -s "$RUN/crashes.log" ] || return 1
  say "containers found not running, beyond a fault's own victim (the run is NOT a pass):"; sed 's/^/  /' "$RUN/crashes.log"
}

# --- scenes: a workload that waits for this script's fault -----------------------------------------------------------
SCENE_LOG=""
SCENE_PID=""
scene_start() {
  mkdir -p "$RUN/logs" "$RUN/cues"
  rm -f "$RUN"/cues/*
  SCENE_LOG="$RUN/logs/scene-$1.$(date +%s).log"
  : > "$SCENE_LOG"
  ( dc exec -T -e ANTITHESIS_SDK_LOCAL_OUTPUT="$(sdk_file "scene-$1")" driver node /repo/deploy/antithesis/driver/main.ts "scene:$1" >> "$SCENE_LOG" 2>&1
    echo "@@ exit $?" >> "$SCENE_LOG" ) &
  SCENE_PID=$!
}
# Waits for the scene to print `@@ <cue> {...}` and prints the {...}. Fails if the scene ended first, or after $2 seconds.
await_cue() {
  local cue=$1 deadline=$(( $(date +%s) + ${2:-180} )) line
  while :; do
    line=$(grep -m1 "^@@ $cue " "$SCENE_LOG") && { printf '%s\n' "${line#@@ "$cue" }"; return 0; }
    grep -q "^@@ exit" "$SCENE_LOG" && return 1
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 0.2
  done
}
give_cue() { : > "$RUN/cues/$1"; }
field() { printf '%s' "$2" | sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }
scene_end() {
  wait "$SCENE_PID"
  grep -v "^@@ \|Failed to load libvoidstar" "$SCENE_LOG"
  grep -q "^@@ exit 0" "$SCENE_LOG" || { say "    (the scene could not finish: see $SCENE_LOG)"; unfinished "scene ${SCENE_LOG##*/scene-}" "$(grep -m1 "COULD NOT RUN" "$SCENE_LOG" | cut -c1-200)"; }
}
# The checks that may run at any moment, beside a scene, while its fault is open.
anytime() { for c in anytime_stranger_probe anytime_journal_contiguous anytime_lease_matches_fence; do drv "$c"; done; }

# Which app containers are not running, read BEFORE anything is started again.
crashes() {
  local svc state out=""
  for svc in $APP_SERVICES; do
    state=$(docker inspect -f '{{.State.Status}}' "$(dc ps -aq "$svc" 2>/dev/null | head -1)" 2>/dev/null)
    case " $* " in *" $svc "*) continue ;; esac # the scenario's own victim
    [ "$state" = running ] || out="$out $svc=$state"
  done
  say "    not running, beyond the fault's own victim: [${out:- none}]"
  [ -z "$out" ] || printf '%s %s\n' "$(date -u +%FT%TZ)" "$out" >> "$RUN/crashes.log"
}
# Whatever a scenario did, undone: toxics, cut proxies, frozen and dead containers.
heal() {
  tox_reset
  local svc
  for svc in $APP_SERVICES postgres redis; do dc unpause "$svc" >/dev/null 2>&1; done
  dc up -d --wait $APP_SERVICES >/dev/null 2>&1
  dc kill worker-2 >/dev/null 2>&1
}

# --- the scenarios -----------------------------------------------------------------------------------------------------
store_unavailable() {
  say "--- store-unavailable: Postgres is cut from both sync nodes, then a peer edits"
  scene_start store-unavailable
  if await_cue armed >/dev/null; then
    tox toggle pg-sync; tox toggle pg-sync-2; give_cue fault; say "    FAULT: pg-sync and pg-sync-2 disabled"
    anytime
    await_cue read-only 90 >/dev/null || say "    the peers were never told read-only"
    crashes
    tox_reset; give_cue healed; say "    Postgres back"
  else say "    the scene never armed"; fi
  scene_end
}
store_slow() {
  local ms=${1:-600} p
  say "--- store-slow: +${ms} ms on every Postgres answer to the sync nodes (under the 5 s journal timeout)"
  for p in pg-sync pg-sync-2; do tox toxic add -t latency -a latency="$ms" -n slow "$p"; done
  drv parallel_driver_edit; drv parallel_driver_viewer_edit; anytime
  crashes
  tox_reset
}
sync_killed() {
  local details owner p
  say "--- sync-killed: Postgres's answers to the sync nodes slowed (+${LATENCY:-150} ms), then the room's owner is killed under a burst"
  for p in pg-sync pg-sync-2; do tox toxic add -t latency -a latency="${LATENCY:-150}" -n slow "$p"; done
  scene_start sync-killed
  if details=$(await_cue burst); then
    owner=$(field owner "$details")
    dc kill -s KILL "$owner" >/dev/null 2>&1; give_cue fault; say "    FAULT: kill -9 $owner (the room's owner)"
    tox_reset
    anytime
  else say "    the scene never reached its burst"; fi
  scene_end
  crashes "$owner"
  [ -n "$owner" ] && dc up -d --wait "$owner" >/dev/null 2>&1
}
sync_paused() {
  local details owner cid t0 late=$(( LEASE_TTL_MS * 2 + 2000 ))
  say "--- sync-paused: the room's owner is frozen past its lease (${LEASE_TTL_MS} ms) with an append on its way to Postgres, ${late} ms late"
  scene_start sync-paused
  if details=$(await_cue armed); then
    owner=$(field owner "$details"); cid=$(dc ps -q "$owner")
    # What the owner SENDS to Postgres arrives late: after its lease has expired and another node has claimed the document.
    tox toxic add -t latency -a latency="$late" -n late -u "pg-$owner"; give_cue slowed
    if await_cue burst >/dev/null; then
      t0=$(date +%s)
      docker pause "$cid" >/dev/null 2>&1; give_cue fault; say "    FAULT: docker pause $owner (the room's owner), its append still in transit"
      if details=$(await_cue moved 180); then
        say "    the room moved to $(field to "$details")"
        anytime
      else say "    the room never moved"; fi
      # The zombie's append must reach Postgres (and meet the fence) before anything is undone.
      while [ $(( $(date +%s) - t0 )) -lt $(( late / 1000 + 2 )) ]; do sleep 0.5; done
      docker unpause "$cid" >/dev/null 2>&1; tox_reset; give_cue resumed; say "    the zombie is woken"
    else say "    the scene never sent its burst"; fi
  else say "    the scene never armed"; fi
  scene_end
  crashes
}
worker_killed() {
  say "--- worker-killed: the AI worker is killed mid-run; a second worker must finish the run"
  scene_start worker-killed
  if await_cue mid-run >/dev/null; then
    dc kill -s KILL worker >/dev/null 2>&1; give_cue fault; say "    FAULT: kill -9 worker (mid-run)"
    dc up -d worker-2 >/dev/null 2>&1
    anytime
  else say "    the scene never got a run under way"; fi
  scene_end
  crashes worker
  dc up -d --wait worker >/dev/null 2>&1; dc kill worker-2 >/dev/null 2>&1
}
worker_paused() {
  say "--- worker-paused: the AI worker is frozen mid-run past staleMs; a second worker takes the job; the first is woken"
  scene_start worker-paused
  if await_cue mid-run >/dev/null; then
    dc pause worker >/dev/null 2>&1; give_cue fault; say "    FAULT: docker pause worker (mid-run)"
    dc up -d worker-2 >/dev/null 2>&1
    anytime
    await_cue retaken 240 >/dev/null && say "    attempt 2 is running on worker-2; the stalled worker is woken" || say "    the job was never taken over"
    dc unpause worker >/dev/null 2>&1; give_cue resumed
  else say "    the scene never got a run under way"; fi
  scene_end
  crashes
  dc kill worker-2 >/dev/null 2>&1
}
redis_wiped() {
  local details
  say "--- redis-wiped: FLUSHALL with runs waiting in Redis and running, and a room open"
  scene_start redis-wiped
  if details=$(await_cue ready-for-wipe 300); then
    dc exec -T redis redis-cli --no-auth-warning FLUSHALL >/dev/null; give_cue fault; say "    FAULT: FLUSHALL $details"
    anytime
  else say "    the scene never had runs waiting and running"; fi
  scene_end
  crashes
}
webhook_dropped() {
  say "--- webhook-dropped: the api's webhook listener is cut, then an engineer pushes to an open document's branch"
  scene_start webhook-dropped
  if await_cue armed 300 >/dev/null; then
    tox toggle webhook; give_cue fault; say "    FAULT: webhook disabled (Gitea's delivery is refused, and Gitea never retries)"
    # Not the stranger's probe: it opens a session, and an opened document asks for a reconcile. The timer is what is tested.
    drv anytime_journal_contiguous; drv anytime_lease_matches_fence
    await_cue applied 120 >/dev/null || say "    the push never reached the canvas"
    crashes
    tox_reset; give_cue healed; say "    the webhook listener is back"
    anytime
  else say "    the scene never had a shipped page to push to"; fi
  scene_end
}
worker_store_unavailable() {
  say "--- worker-store-unavailable: Postgres is cut from the api and the workers mid-run, until the job's heartbeat is older than staleMs; nobody dies"
  scene_start worker-store-unavailable
  if await_cue mid-run >/dev/null; then
    tox toggle pg; give_cue fault; say "    FAULT: pg disabled (the api's and the workers' Postgres; the sync nodes keep theirs)"
    drv anytime_journal_contiguous; drv anytime_lease_matches_fence
    await_cue stale 120 >/dev/null || say "    the job's heartbeat never went stale"
    crashes
    tox_reset; give_cue healed; say "    Postgres back"
  else say "    the scene never got a run under way"; fi
  scene_end
  crashes
}
# $1 = how MinIO is away (unavailable | stalled), $2 = "open" when the fault comes while the room is still open.
minio_away() {
  local how=$1 scene=minio-reopen
  [ "${2:-}" = open ] && scene=minio-open
  say "--- minio-$how ($scene): a snapshotted document is reopened while MinIO is away"
  scene_start "$scene"
  if await_cue armed >/dev/null; then
    if [ "$how" = stalled ]; then
      # Accepts the connection and never answers, in both directions: "slow" taken to its end.
      tox toxic add -t timeout -a timeout=0 -n stall minio; tox toxic add -t timeout -a timeout=0 -n stall-up -u minio
      say "    FAULT: minio stalled (connections accepted, nothing answered)"
    else tox toggle minio; say "    FAULT: minio disabled"; fi
    give_cue fault
    await_cue probed 120 >/dev/null || say "    the scene never probed the document"
    anytime
    crashes
    tox_reset; give_cue healed; say "    MinIO back"
  else say "    the scene never had a snapshotted document"; fi
  scene_end
  crashes
}
upgrade_reset() {
  say "--- upgrade-reset: connections the room's owner refuses (no token) are reset by their client, under edits"
  scene_start upgrade-reset
  if await_cue armed >/dev/null; then
    give_cue fault; say "    FAULT: 20 refused upgrades, each reset by its client (made by the scene: the fault is a client's)"
    await_cue knocked 60 >/dev/null || say "    the scene never knocked"
    anytime
    crashes
    give_cue checked
  else say "    the scene never had a room"; fi
  scene_end
}
minio_unavailable() { minio_away unavailable "$@"; }
minio_stalled() { minio_away stalled "$@"; }
SCENARIOS="store-unavailable store-slow sync-killed sync-paused worker-killed worker-paused redis-wiped webhook-dropped worker-store-unavailable upgrade-reset minio-unavailable minio-stalled"
scenario() { local name=$1; shift; "${name//-/_}" "$@"; heal; }

# --- the runs ----------------------------------------------------------------------------------------------------------
quiet() {
  say "--- quiet: the test template's drivers, no fault"
  local c
  for c in parallel_driver_edit parallel_driver_viewer_edit parallel_driver_start_twice parallel_driver_ai_and_person parallel_driver_end_run_early parallel_driver_stale_message parallel_driver_ship parallel_driver_share_revoke parallel_driver_engineer_push; do drv "$c"; done
  anytime
}
# The SUT's own output since the last reset, where the driver can read it (finally_sut_logs).
collect_logs() {
  local svc since
  since=$(cat "$RUN/since" 2>/dev/null || date -u +%FT%TZ)
  mkdir -p "$RUN/logs"
  for svc in postgres worker worker-2 sync sync-2 worker-git worker-ship api; do dc logs --no-color --no-log-prefix --since "$since" "$svc" > "$RUN/logs/$svc.log" 2>/dev/null; done
}
judge() {
  say "--- the faults are over: eventually_ and finally_"
  local c
  collect_logs
  for c in eventually_room_writable eventually_jobs_settle eventually_revoked_share_closed eventually_push_on_canvas finally_ledger finally_peers_converge finally_jobs finally_ship finally_sut_logs finally_windows_reached; do drv "$c"; done
  anytime
}
report() {
  if command -v node >/dev/null 2>&1; then node "$HERE/driver/report.ts" "$RUN/sdk" "$@"
  else dc exec -T driver node /repo/deploy/antithesis/driver/report.ts /var/antithesis/sdk "$@"; fi
}
reset() {
  heal
  rm -rf "$RUN/sdk" "$RUN/ledger" "$RUN/cues" "$RUN/logs" "$RUN/jobs.jsonl" "$RUN/revokes.jsonl" "$RUN/pushes.jsonl" "$RUN/facts.jsonl" "$RUN/tokens.json" "$RUN/crashes.log" "$RUN/unfinished.log"
  mkdir -p "$RUN/sdk" "$RUN/ledger" "$RUN/cues" "$RUN/logs"
  date -u +%FT%TZ > "$RUN/since"
}

up() {
  local minio tar token
  mkdir -p "$RUN/sdk" "$RUN/ledger" "$RUN/cues" "$RUN/logs"
  [ -f "$RUN/since" ] || date -u +%FT%TZ > "$RUN/since"
  # The pinned MinIO image cannot be pulled any more: it must be here already (init.sh's saved copy), never fetched.
  minio=$(sed -n 's/^ *image: \(.*minio\/minio:.*\)$/\1/p' docker-compose.yaml)
  tar="$HOME/.config/noon/minio-${minio##*:}.tar"
  docker image inspect "$minio" >/dev/null 2>&1 || { [ -f "$tar" ] && docker load -i "$tar" >/dev/null; } || { say "FAIL: $minio is not on this machine and there is no saved copy at $tar"; return 1; }
  say "--- building the app image (the repo's Dockerfile, unchanged) and the driver image"
  docker build -q -t "noon-antithesis-app:$APP_TAG" -f "$ROOT/Dockerfile" "$ROOT" >/dev/null || { say "FAIL: the app image did not build"; return 1; }
  docker build -q -t "noon-antithesis-driver:$DRIVER_TAG" --build-arg BASE="noon-antithesis-app:$APP_TAG" -f "$HERE/Dockerfile.driver" "$ROOT" >/dev/null || { say "FAIL: the driver image did not build"; return 1; }
  say "--- starting the stores"
  dc up -d --wait postgres redis minio gitea toxiproxy || { say "FAIL: the stores did not start"; return 1; }
  # Gitea's user and its token (Gitea issues it: the one secret here that cannot be a constant). Kept while it works.
  if ! dc exec -T gitea curl -fsS -o /dev/null -H "Authorization: token ${GITEA_TOKEN:-none}" http://localhost:3000/api/v1/user 2>/dev/null; then
    dc exec -T -u git gitea gitea admin user list | awk 'NR > 1 { print $2 }' | grep -qx noon ||
      dc exec -T -u git gitea gitea admin user create --username noon --password harness-gitea-password --email noon@harness.test --admin --must-change-password=false >/dev/null
    token=$(dc exec -T -u git gitea gitea admin user generate-access-token --username noon --token-name "harness-$(date +%s)" --scopes write:repository,write:user --raw | tr -d '\r\n')
    [ -n "$token" ] || { say "FAIL: Gitea did not issue a token"; return 1; }
    printf 'GITEA_TOKEN=%s\n' "$token" > "$RUN/gitea.env"
    export GITEA_TOKEN="$token"
  fi
  say "--- starting the app (unchanged images) and the driver"
  dc up -d --wait $APP_SERVICES driver || { say "FAIL: the slice did not start (a code change needed to boot would be a finding: see the logs)"; dc ps -a; return 1; }
  drv first_setup || { say "FAIL: first_setup"; return 1; }
  dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
}

no_internet() {
  local fail=0 n c ports nets svc networks
  say "--- harness:no-internet"
  networks=$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
  [ -n "$networks" ] || { say "FAIL: the slice is not up (no network)"; return 1; }
  for n in $networks; do
    [ "$(docker network inspect -f '{{.Internal}}' "$n")" = true ] && say "PASS  network $(docker network inspect -f '{{.Name}}' "$n") is internal" || { say "FAIL  network $n is not internal"; fail=1; }
  done
  for c in $(dc ps -q); do
    ports=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$c")
    nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")
    [ -z "$ports" ] || { say "FAIL  $(docker inspect -f '{{.Name}}' "$c") publishes $ports"; fail=1; }
    [ "$nets" = "${COMPOSE_PROJECT_NAME}_hermetic " ] || { say "FAIL  $(docker inspect -f '{{.Name}}' "$c") is on: $nets"; fail=1; }
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -Eq '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=.+' && { say "FAIL  $(docker inspect -f '{{.Name}}' "$c") holds a model credential"; fail=1; }
  done
  [ "$fail" = 0 ] && say "PASS  no container publishes a port, is on another network, or holds a model credential"
  # From inside: an address, a name and the model's host must all be out of reach, while a neighbour answers
  # (without that control a broken probe would pass).
  for svc in driver api sync worker worker-ship; do
    dc exec -T "$svc" node -e '
      const net = require("node:net"), dns = require("node:dns/promises");
      const dial = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); done(true); }); s.on("timeout", () => { s.destroy(); done(false); }); s.on("error", () => done(false)); });
      (async () => {
        const out = { address: await dial("1.1.1.1", 443), name: await dns.lookup("registry.npmjs.org").then(() => true, () => false), model: await fetch("https://api.anthropic.com", { signal: AbortSignal.timeout(3000) }).then(() => true, () => false), neighbour: await dial("toxiproxy", 8474) };
        const hermetic = !out.address && !out.name && !out.model && out.neighbour;
        console.log((hermetic ? "PASS  " : "FAIL  ") + process.argv[1] + " reaches nothing outside " + JSON.stringify(out));
        process.exit(hermetic ? 0 : 1);
      })();' "$svc" 2>/dev/null || fail=1
  done
  [ "$fail" = 0 ] && say "harness:no-internet: PASS" || say "harness:no-internet: FAIL"
  return "$fail"
}

case "${1:-}" in
  up) up ;;
  quiet) reset; quiet; judge; report ;;
  baseline)
    reset
    say "=== baseline, part 1: the quiet workload"
    quiet
    say "=== baseline, part 2: one of each fault window, so that every vacuity guard can fire"
    for s in store-unavailable sync-killed sync-paused worker-killed worker-paused redis-wiped webhook-dropped; do scenario "$s"; done
    judge
    say "=== report"
    report --require pass; pass=$?
    report --require guards >/dev/null; guards=$?
    [ "$guards" = 0 ] && say 'harness check "guards": PASS' || report --require guards | sed -n '/^harness check/,$p'
    found_dead && pass=1
    could_not_finish && pass=1
    exit $(( pass | guards )) ;;
  chaos)
    rounds=${2:-6}; results="$RUN/chaos-results.txt"; mkdir -p "$RUN/rounds"; : > "$results"
    set -- $SCENARIOS
    for i in $(seq 1 "$rounds"); do
      reset
      shift $(( RANDOM % $# )); pick=$1; set -- $SCENARIOS
      LATENCY=$(( RANDOM % 300 + 50 ))
      say "=== chaos round $i: $pick"
      drv parallel_driver_edit; drv parallel_driver_ai_and_person
      LATENCY=$LATENCY scenario "$pick"
      judge
      report --require round > "$RUN/rounds/round-$i.txt" 2>&1 && verdict=PASS || verdict=FAIL
      could_not_finish >> "$RUN/rounds/round-$i.txt" && verdict=FAIL
      crash=$(cat "$RUN/crashes.log" 2>/dev/null | tr '\n' ' ')
      [ -z "$crash" ] || verdict=FAIL # a container found dead that the fault did not kill
      say "round $i  $verdict  scenario=$pick  crash=[${crash:- none}]" | tee -a "$results"
      [ "$verdict" = PASS ] || grep -E "FAIL|NOT RUN|could not finish|^  " "$RUN/rounds/round-$i.txt"
    done
    say "=== chaos summary"; cat "$results"
    ! grep -q " FAIL " "$results" ;;
  report) shift; report "$@" ;;
  no-internet) no_internet ;;
  reset) reset; say "reset done" ;;
  down) dc down -v --remove-orphans ;;
  *)
    case " $SCENARIOS " in
      *" ${1:-} "*) name=$1; shift; reset; scenario "$name" "$@"; judge; report --require round; verdict=$?; could_not_finish && verdict=1; found_dead && verdict=1; exit "$verdict" ;;
      *) sed -n '2,28p' "$HERE/${0##*/}" ;;
    esac ;;
esac
