#!/bin/bash
# CIDRella shared log + event library.
#
# Source this file; do not execute it. Sourced by install.sh, update.sh,
# and (optionally) rollback.sh. Provides:
#   - Colored stderr helpers: info, ok, warn, err, bold
#   - Structured JSONL event emission: emit_event
#
# Event log path defaults to /var/lib/cidrella/events.jsonl and can be
# overridden by setting CIDRELLA_EVENT_LOG before sourcing.

if [ "${__CIDRELLA_LOG_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_LOG_LIB_LOADED=1

: "${CIDRELLA_EVENT_LOG:=/var/lib/cidrella/events.jsonl}"

# Suppress interactive color codes when the UI is scraping stdout
# (caller sets FROM_API=true when invoked by the server's update flow).
_color_enabled() {
  [ "${FROM_API:-false}" = "true" ] && return 1
  [ -t 2 ] || return 1
  return 0
}

if _color_enabled; then
  _C_RESET=$'\033[0m'
  _C_BOLD=$'\033[1m'
  _C_RED=$'\033[0;31m'
  _C_GRN=$'\033[0;32m'
  _C_YLW=$'\033[1;33m'
  _C_BLU=$'\033[0;34m'
else
  _C_RESET=""; _C_BOLD=""; _C_RED=""; _C_GRN=""; _C_YLW=""; _C_BLU=""
fi

info() { [ "${FROM_API:-false}" = "true" ] && return 0; printf "%s[INFO]%s %s\n" "$_C_BLU" "$_C_RESET" "$*" >&2; }
ok()   { [ "${FROM_API:-false}" = "true" ] && return 0; printf "%s[OK]%s %s\n"   "$_C_GRN" "$_C_RESET" "$*" >&2; }
warn() { [ "${FROM_API:-false}" = "true" ] && return 0; printf "%s[WARN]%s %s\n" "$_C_YLW" "$_C_RESET" "$*" >&2; }
err()  { printf "%s[ERROR]%s %s\n" "$_C_RED" "$_C_RESET" "$*" >&2; }
bold() { [ "${FROM_API:-false}" = "true" ] && return 0; printf "%s%s%s\n" "$_C_BOLD" "$*" "$_C_RESET" >&2; }

# _json_escape <string>
#   Escape backslashes and double quotes for safe JSON string embedding.
#   Control characters below 0x20 are stripped (tr -d).
_json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'
}

# emit_event <phase> <event> [key=value ...]
#   phase: preflight|download|verify|extract|snapshot|switchover|health|cleanup|...
#   event: start|pass|fail|warn|skip|end
#   extra: optional key=value pairs; values are JSON-string-escaped.
#
# Appends one JSON object per line to $CIDRELLA_EVENT_LOG. Silently falls
# back to stderr if the log's directory is not writable (e.g., install.sh
# running before /var/lib/cidrella exists).
emit_event() {
  local phase="${1:-unknown}"
  local event="${2:-unknown}"
  shift 2 2>/dev/null || true

  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local data="" sep=""
  local kv k v v_esc
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    v_esc=$(_json_escape "$v")
    data="${data}${sep}\"${k}\":\"${v_esc}\""
    sep=","
  done

  local line="{\"ts\":\"${ts}\",\"phase\":\"${phase}\",\"event\":\"${event}\",\"data\":{${data}}}"

  local dir
  dir=$(dirname "$CIDRELLA_EVENT_LOG")
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    printf '%s\n' "$line" >> "$CIDRELLA_EVENT_LOG" 2>/dev/null || printf '[event] %s\n' "$line" >&2
  elif [ -f "$CIDRELLA_EVENT_LOG" ] && [ -w "$CIDRELLA_EVENT_LOG" ]; then
    printf '%s\n' "$line" >> "$CIDRELLA_EVENT_LOG"
  else
    printf '[event] %s\n' "$line" >&2
  fi
}
