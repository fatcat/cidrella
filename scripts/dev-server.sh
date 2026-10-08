#!/usr/bin/env bash
#
# CIDRella dev server control.
#
# Starts the same two processes as `npm run dev:server` and `npm run dev:client`,
# but backgrounded with pid files, so you can stop them again without hunting
# for stray node processes. Logs and pid files go to tmp/dev/ (gitignored).
#
# Usage:
#   scripts/dev-server.sh start   [server|client|all]
#   scripts/dev-server.sh stop    [server|client|all]
#   scripts/dev-server.sh restart [server|client|all]
#   scripts/dev-server.sh status
#   scripts/dev-server.sh urls
#   scripts/dev-server.sh logs    [server|client]     # tail -f, ctrl-c to quit
#
# Target defaults to "all".
#
# start, restart, status and urls print the live URLs, read back from the logs
# rather than assumed: the backend's HTTPS port comes from a DB setting you can
# change in the UI, and vite walks forward from 5173 when something already
# holds it. The host defaults to this box's WSL address so the URLs work from
# Windows, override it with DEV_HOST=...
#
# On start and restart the dev admin password is reset to a known value so a
# fresh dev DB never locks you out (the random one it prints on first boot
# scrolls away). Skip it with --no-password, change it with
# DEV_ADMIN_PASSWORD=... That reset refuses to touch anything but this tree's
# server/data/cidrella.db, see scripts/dev-set-password.js.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/tmp/dev"
SET_PASSWORD=1

# The address Windows can reach this WSL box on. WSL2 hands eth0 a fresh DHCP
# lease on most restarts, so detect it rather than pin it. The literal is only
# the last resort, and it is the value eth0 happened to hold when this script
# was written.
resolve_host() {
  local detected
  detected="$(ip route get 1 2>/dev/null | grep -oP 'src \K\S+' || true)"
  echo "${detected:-172.19.87.89}"
}
DEV_HOST="${DEV_HOST:-$(resolve_host)}"

# Print the header comment block as the help text, so there is only one copy
# of the usage to keep current.
usage() {
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
}

# Per-target settings. Everything below drives off these lookups instead of
# duplicating a server branch and a client branch in every function.
pid_file() { echo "$LOG_DIR/$1.pid"; }
log_file() { echo "$LOG_DIR/$1.log"; }

run_dir() {
  case "$1" in
    server) echo "$ROOT_DIR/server" ;;
    client) echo "$ROOT_DIR/client" ;;
  esac
}

run_cmd() {
  case "$1" in
    server) echo "exec node src/index.js" ;;
    client) echo "exec npx vite --host" ;;
  esac
}

is_running() {
  local pid_file pid
  pid_file="$(pid_file "$1")"
  [[ -f "$pid_file" ]] || return 1
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Read the port the process actually bound out of its own log. Matching on
# ":port" rather than the whole URL keeps this working if vite ever emits
# color codes between the label and the address.
port_of() {
  local name="$1" log
  log="$(log_file "$name")"
  [[ -f "$log" ]] || return 0
  case "$name" in
    server)
      grep -o 'HTTPS server listening on port [0-9]*' "$log" 2>/dev/null \
        | tail -1 | grep -o '[0-9]*$' || true
      ;;
    client)
      grep 'Local:' "$log" 2>/dev/null | tail -1 \
        | grep -oE ':[0-9]{2,5}' | tail -1 | tr -d ':' || true
      ;;
  esac
}

url_for() {
  local name="$1" port
  port="$(port_of "$name")"
  [[ -n "$port" ]] || return 1
  case "$name" in
    server) echo "https://$DEV_HOST:$port" ;;
    client) echo "http://$DEV_HOST:$port" ;;
  esac
}

# Wait for a target to report its port. Gives up after 30s and lets the caller
# carry on, a slow boot is not a reason to fail the whole command.
wait_for_port() {
  local name="$1"
  for _ in {1..300}; do
    [[ -n "$(port_of "$name")" ]] && return 0
    is_running "$name" || return 1
    sleep 0.1
  done
  return 1
}

start_one() {
  local name="$1" dir log pid
  dir="$(run_dir "$name")"
  log="$(log_file "$name")"

  if is_running "$name"; then
    echo "$name already running (pid $(cat "$(pid_file "$name")"))"
    return 0
  fi

  # setsid puts each process in its own group so stop_one can signal the whole
  # tree. npx vite in particular spawns a child that outlives a bare kill.
  setsid bash -lc "cd '$dir' && $(run_cmd "$name")" >"$log" 2>&1 &
  pid=$!
  echo "$pid" > "$(pid_file "$name")"
  echo "started $name (pid $pid), logging to $log"
}

stop_one() {
  local name="$1" pid_file pid
  pid_file="$(pid_file "$name")"

  if [[ ! -f "$pid_file" ]]; then
    stop_stale "$name"
    return 0
  fi

  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    stop_stale "$name"
    return 0
  fi

  echo "stopping $name (pid $pid)..."
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  for _ in {1..30}; do
    kill -0 "$pid" 2>/dev/null || { stop_stale "$name"; return 0; }
    sleep 0.1
  done

  echo "$name did not exit, sending KILL"
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  stop_stale "$name"
}

# Catch processes from a previous run whose pid file was lost (killed terminal,
# deleted tmp/). Match on working directory so we never touch a dev server
# running out of some other checkout of this repo.
stop_stale() {
  local name="$1" pattern dir pid cwd
  dir="$(run_dir "$name")"
  case "$name" in
    server) pattern="node src/index.js" ;;
    client) pattern="vite --host" ;;
  esac

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$cwd" == "$dir" ]]; then
      echo "stopping stale $name process (pid $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

set_dev_password() {
  # The backend creates and migrates the DB on first boot, so the reset has to
  # wait for it to be listening.
  if ! wait_for_port server; then
    echo "backend never reported a listening port, skipping the password reset"
    echo "  check $(log_file server)"
    return 0
  fi
  node "$ROOT_DIR/scripts/dev-set-password.js" || true
}

print_urls() {
  local name url shown=0
  for name in server client; do
    is_running "$name" || continue
    wait_for_port "$name" || true
    if url="$(url_for "$name")"; then
      [[ "$shown" -eq 0 ]] && { echo; shown=1; }
      printf '  %-7s %s\n' "$name" "$url"
    fi
  done
}

status_one() {
  local name="$1" url
  if ! is_running "$name"; then
    printf '  %-7s stopped\n' "$name"
    return 0
  fi
  url="$(url_for "$name" || echo 'port not reported yet')"
  printf '  %-7s running (pid %s)  %s\n' "$name" "$(cat "$(pid_file "$name")")" "$url"
}

# Argument parsing. Flags may appear anywhere, the first non-flag word is the
# command and the second is the target.
COMMAND=""
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --no-password) SET_PASSWORD=0 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$COMMAND" ]]; then COMMAND="$arg"
      elif [[ -z "$TARGET" ]]; then TARGET="$arg"
      else echo "unexpected argument: $arg" >&2; usage >&2; exit 1
      fi
      ;;
  esac
done

COMMAND="${COMMAND:-}"
TARGET="${TARGET:-all}"

case "$TARGET" in
  all) TARGETS=(server client) ;;
  server|client) TARGETS=("$TARGET") ;;
  *) echo "unknown target: $TARGET (want server, client, or all)" >&2; exit 1 ;;
esac

mkdir -p "$LOG_DIR"

case "$COMMAND" in
  start|restart)
    if [[ "$COMMAND" == "restart" ]]; then
      for name in client server; do
        [[ " ${TARGETS[*]} " == *" $name "* ]] && stop_one "$name"
      done
    fi
    for name in "${TARGETS[@]}"; do start_one "$name"; done
    if [[ "$SET_PASSWORD" -eq 1 ]] && [[ " ${TARGETS[*]} " == *" server "* ]]; then
      set_dev_password
    fi
    print_urls
    ;;

  stop)
    # Stop the client first so vite is not left proxying at a dead backend.
    for name in client server; do
      [[ " ${TARGETS[*]} " == *" $name "* ]] && stop_one "$name"
    done
    ;;

  status)
    echo "CIDRella dev servers:"
    for name in server client; do status_one "$name"; done
    ;;

  urls)
    for name in server client; do
      is_running "$name" || continue
      url_for "$name" && continue
      echo "$name is running but has not reported a port yet" >&2
    done
    ;;

  logs)
    if [[ "$TARGET" == "all" ]]; then
      tail -f "$(log_file server)" "$(log_file client)"
    else
      tail -f "$(log_file "$TARGET")"
    fi
    ;;

  ""|help)
    usage
    [[ -z "$COMMAND" ]] && exit 1 || exit 0
    ;;

  *)
    echo "unknown command: $COMMAND" >&2
    usage >&2
    exit 1
    ;;
esac
