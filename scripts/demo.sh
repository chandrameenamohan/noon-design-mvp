#!/bin/sh
# The public demo (E11), from this laptop, with no terminal or Claude session kept open:
#   scripts/demo.sh up       start whatever is not running; a piece already listening on its port is left alone
#   scripts/demo.sh status   each piece, and whether the public URL answers /api/ready through basic auth
#   scripts/demo.sh down     stop the processes `up` started (by its pid files); the compose stack stays
# Pieces: the compose api with the public addresses, Vite for the public host (5173) and for localhost (5199),
# and ngrok in front of 5173. The rest of the compose stack is assumed up (./init.sh).
# One-time files, outside the repo: ~/.config/noon/ngrok-host (the ngrok static domain), ngrok-pass (the
# basic-auth password of user noon), ngrok-policy.yml (the traffic policy that holds the same credentials).
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

conf="$HOME/.config/noon"
run="${XDG_STATE_HOME:-$HOME/.local/state}/noon-demo" # pid files and logs
host=$(cat "$conf/ngrok-host")
sync_public="sync=wss://$host/sync,sync-2=wss://$host/sync-2"
api_port="${API_PORT:-3000}"

listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

api_sync_public() {
  id=$(docker compose ps -q api 2>/dev/null) && [ -n "$id" ] || return 0
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n 's/^SYNC_PUBLIC_URL=//p'
}

# start NAME PORT CMD...: detached (nohup, stdin closed), so it outlives the shell that ran `up`.
start() {
  name=$1 port=$2
  shift 2
  if pid=$(listener "$port") && [ -n "$pid" ]; then
    echo "$name: already listening on $port (pid $pid), left alone"
    return
  fi
  nohup "$@" >"$run/$name.log" 2>&1 </dev/null &
  echo $! >"$run/$name.pid"
  # ponytail: a fixed 30 s wait for the port; enough for Vite and ngrok on this laptop.
  i=0
  until [ -n "$(listener "$port")" ]; do
    i=$((i + 1))
    [ $i -le 60 ] || { echo "$name: FAIL, nothing on $port after 30 s; see $run/$name.log"; exit 1; }
    sleep 0.5
  done
  echo "$name: started pid $(cat "$run/$name.pid"), log $run/$name.log"
}

up() {
  mkdir -p "$run"
  if [ "$(api_sync_public)" = "$sync_public" ]; then
    echo "api: already has the public addresses, left alone"
  else
    SYNC_PUBLIC_URL="$sync_public" PREVIEW_PUBLIC_URL="https://$host" docker compose up -d --no-build --wait api
    echo "api: recreated with the public addresses"
  fi
  # env + .bin/vite both exec, so the pid recorded is Vite's own.
  (cd apps/web && start web-public 5173 env PUBLIC_HOST="$host" ./node_modules/.bin/vite --port 5173 --strictPort)
  (cd apps/web && start web-local 5199 ./node_modules/.bin/vite --port 5199 --strictPort)
  # 4040 is the ngrok agent's local API.
  start ngrok 4040 ngrok http 5173 --traffic-policy-file "$conf/ngrok-policy.yml" --log stdout
}

down() {
  for name in ngrok web-local web-public; do
    f="$run/$name.pid"
    [ -f "$f" ] || continue
    pid=$(cat "$f")
    # A pid file can outlive its process, and the pid be reused: only kill a vite or ngrok.
    if ps -o command= -p "$pid" 2>/dev/null | grep -Eq 'vite|ngrok'; then
      kill "$pid" && echo "$name: stopped pid $pid"
    else
      echo "$name: pid $pid not running"
    fi
    rm -f "$f"
  done
}

status() {
  ok=0
  for piece in web-public:5173 web-local:5199 ngrok:4040; do
    name=${piece%:*} port=${piece#*:}
    pid=$(listener "$port")
    ours=""
    [ -n "$pid" ] && [ "$(cat "$run/$name.pid" 2>/dev/null)" = "$pid" ] && ours=", started by demo.sh"
    if [ -n "$pid" ]; then echo "$name: up on $port (pid $pid$ours)"; else echo "$name: DOWN (nothing on $port)" && ok=1; fi
  done
  tunnel=$(curl -s --max-time 3 localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | cut -d'"' -f4 || true)
  echo "ngrok tunnel: ${tunnel:-none}"
  if [ "$(api_sync_public)" = "$sync_public" ]; then addresses=public; else addresses="NOT public" && ok=1; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "localhost:$api_port/ready" || true)
  echo "api: /ready $code on $api_port, $addresses addresses"
  [ "$code" = 200 ] || ok=1
  # The password goes to curl on stdin, never on a command line or the screen.
  code=$(printf 'user = "noon:%s"\n' "$(cat "$conf/ngrok-pass")" |
    curl -s -K - -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/api/ready" || true)
  echo "public: https://$host/api/ready -> $code (basic auth)"
  [ "$code" = 200 ] || ok=1
  return $ok
}

case "${1:-}" in
  up | down | status) "$1" ;;
  *) echo "usage: $0 up|down|status" >&2 && exit 2 ;;
esac
