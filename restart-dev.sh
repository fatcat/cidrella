#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/tmp/dev"
BACKEND_PID="$LOG_DIR/backend.pid"
CLIENT_PID="$LOG_DIR/client.pid"
BACKEND_LOG="$LOG_DIR/backend.log"
CLIENT_LOG="$LOG_DIR/client.log"

mkdir -p "$LOG_DIR"

stop_group() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "Stopping $name (pid $pid)..."
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done

  echo "Force stopping $name (pid $pid)..."
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

stop_stale_matching_cwd() {
  local name="$1"
  local pattern="$2"
  local expected_cwd="$3"

  while read -r pid; do
    [[ -z "$pid" ]] && continue
    local cwd
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$cwd" == "$expected_cwd" ]]; then
      echo "Stopping stale $name process (pid $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

start_backend() {
  echo "Starting backend..."
  setsid bash -lc "cd '$ROOT_DIR/server' && exec node src/index.js" >"$BACKEND_LOG" 2>&1 &
  echo "$!" > "$BACKEND_PID"
}

start_client() {
  echo "Starting frontend..."
  setsid bash -lc "cd '$ROOT_DIR/client' && exec npx vite --host" >"$CLIENT_LOG" 2>&1 &
  echo "$!" > "$CLIENT_PID"
}

stop_group "frontend" "$CLIENT_PID"
stop_group "backend" "$BACKEND_PID"

stop_stale_matching_cwd "frontend" "vite --host" "$ROOT_DIR/client"
stop_stale_matching_cwd "backend" "node src/index.js" "$ROOT_DIR/server"

start_backend
start_client

echo
echo "CIDRella dev servers restarted."
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $CLIENT_LOG"
echo "Frontend URL is usually shown in the frontend log after Vite starts."
