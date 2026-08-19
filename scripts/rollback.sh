#!/bin/bash
set -euo pipefail

# Anchor CWD to / so we never depend on the invoker's working directory.
# Rollback wipes slots in the same way update.sh does, so the same CWD
# unlinking risk applies. See the note in update.sh for the incident.
cd / 2>/dev/null || true

# ═══════════════════════════════════════════════════════════
# CIDRella Rollback
# Standalone rollback script, does NOT depend on CIDRella code,
# network, or DNS resolution.
#
# Restores the previous (inactive) slot and the pre-update
# database snapshot.
#
# Usage:
#   cidrella-rollback              # interactive
#   cidrella-rollback --yes        # non-interactive (for scripts)
#   cidrella-rollback --list       # show what would be restored
#
# This script is copied from the CURRENTLY RUNNING version into
# /usr/local/bin/ at the start of every update, so it's always
# the last known-good rollback logic even if the new update fails.
# ═══════════════════════════════════════════════════════════

INSTALL_LINK="/opt/cidrella"
SLOT_A="/opt/cidrella-a"
SLOT_B="/opt/cidrella-b"
DATA_DIR="/var/lib/cidrella"
SNAPSHOT_DIR="${DATA_DIR}/snapshots/pre-update"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Minimal inline JSONL event emitter, rollback MUST stay standalone, so
# we deliberately do not source scripts/lib/log.sh here. This produces the
# same JSONL format as lib/log.sh for consistent downstream parsing.
emit_event() {
  local phase="${1:-unknown}" event="${2:-unknown}"
  shift 2 2>/dev/null || true
  local ts data="" sep="" kv k v v_esc
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    v_esc=$(printf '%s' "$v" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037')
    data="${data}${sep}\"${k}\":\"${v_esc}\""; sep=","
  done
  local line="{\"ts\":\"${ts}\",\"phase\":\"${phase}\",\"event\":\"${event}\",\"data\":{${data}}}"
  local dir="${CIDRELLA_EVENT_LOG_DIR:-/var/lib/cidrella}"
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    printf '%s\n' "$line" >> "$dir/events.jsonl" 2>/dev/null || true
  fi
}

# ─── Node resolver ────────────────────────────────────────
# Rollback must be standalone, no dependence on the installation being
# rolled back. Inline the bundled-runtime check so this script stays
# self-contained even if /usr/local/bin/cidrella-node was wiped.
# MUST stay a copy: this script sources nothing on purpose (see above), so it
# cannot use resolve_node from lib/slots.sh. It is kept deliberately identical
# in behavior to that one, and scripts/test-harness/resolve-node-differential.sh
# asserts the two agree. If you change one, change both.
# See REVIEW.md, duplicate-logic audit #33.
resolve_node() {
  local slot="${1:-}"
  local candidate
  for candidate in \
    "${slot:+$slot/runtime/node/bin/node}" \
    "/opt/cidrella/runtime/node/bin/node" \
    "/usr/local/bin/cidrella-node"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

AUTO_YES=false
LIST_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) AUTO_YES=true; shift ;;
    --list|-l) LIST_ONLY=true; shift ;;
    -h|--help)
      cat <<USAGE
Usage: cidrella-rollback [--yes|--list]

Restores the previous CIDRella slot and the pre-update database snapshot.

  --yes, -y   Non-interactive, assume yes
  --list, -l  Show what would be restored without doing anything
USAGE
      exit 0
      ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ─── Preflight ────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
  exit 1
fi

if [ ! -L "$INSTALL_LINK" ]; then
  err "$INSTALL_LINK is not a symlink, A/B rollback not available."
  err "This installation predates the A/B update system."
  err "Look for backup directories: ls -la /opt/cidrella.bak-*"
  exit 1
fi

# Detect active and inactive slot
ACTIVE_SLOT="$(readlink -f "$INSTALL_LINK")"
case "$ACTIVE_SLOT" in
  "$SLOT_A") INACTIVE_SLOT="$SLOT_B" ;;
  "$SLOT_B") INACTIVE_SLOT="$SLOT_A" ;;
  *) err "Active slot is not slot-a or slot-b: $ACTIVE_SLOT"; exit 1 ;;
esac

if [ ! -d "$INACTIVE_SLOT" ]; then
  err "Previous slot does not exist: $INACTIVE_SLOT"
  err "There is nothing to roll back to."
  exit 1
fi

# Read versions
read_version() {
  local dir="$1"
  if [ -f "$dir/package.json" ]; then
    local node_bin
    # resolve_node can now return nonzero instead of an untested path, so guard
    # it: under set -e a bare assignment from a failing substitution aborts.
    node_bin=$(resolve_node "$dir" || true)
    if [ -n "$node_bin" ]; then
      "$node_bin" -e "console.log(require('$dir/package.json').version)" 2>/dev/null || echo "unknown"
    else
      # No node anywhere. Fall back to reading the file directly rather than
      # reporting "unknown", which is what read_slot_version does in lib/slots.sh.
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/package.json" | head -n 1
    fi
  else
    echo "unknown"
  fi
}

ACTIVE_VERSION=$(read_version "$ACTIVE_SLOT")
INACTIVE_VERSION=$(read_version "$INACTIVE_SLOT")

# Check snapshot availability
HAS_SNAPSHOT=false
if [ -f "$SNAPSHOT_DIR/cidrella.db" ]; then
  HAS_SNAPSHOT=true
fi

# ─── Summary ──────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══ CIDRella Rollback ═══${NC}"
echo ""
echo -e "  Currently active:  ${BOLD}v${ACTIVE_VERSION}${NC}  (${ACTIVE_SLOT})"
echo -e "  Will restore:      ${BOLD}v${INACTIVE_VERSION}${NC}  (${INACTIVE_SLOT})"
echo ""
if [ "$HAS_SNAPSHOT" = true ]; then
  SNAPSHOT_AGE=$(stat -c %y "$SNAPSHOT_DIR/cidrella.db" 2>/dev/null | cut -d. -f1)
  echo -e "  DB snapshot:       ${GREEN}available${NC} (${SNAPSHOT_AGE})"
  echo "                     cidrella.db + analytics.duckdb will be restored"
else
  echo -e "  DB snapshot:       ${YELLOW}NOT FOUND${NC}"
  echo "                     Database will NOT be rolled back, schema mismatches may occur."
fi
echo ""

if [ "$LIST_ONLY" = true ]; then
  exit 0
fi

# Confirm
if [ "$AUTO_YES" = false ]; then
  read -rp "$(echo -e "${BOLD}Proceed with rollback? [y/N]:${NC} ")" yn
  yn="${yn:-n}"
  case "$yn" in
    [Yy]*) ;;
    *) info "Rollback cancelled."; emit_event rollback skip reason=user-cancel; exit 0 ;;
  esac
fi

# ─── Execute rollback ─────────────────────────────────────

emit_event rollback start "from=$ACTIVE_VERSION" "to=$INACTIVE_VERSION" "has_snapshot=$HAS_SNAPSHOT"
info "Stopping CIDRella..."
systemctl stop cidrella || warn "cidrella service was not running"

# Restore DB snapshot first (while service is down)
if [ "$HAS_SNAPSHOT" = true ]; then
  info "Restoring database snapshot..."
  # Copy snapshot back; include WAL files
  cp -a "$SNAPSHOT_DIR/cidrella.db" "$DATA_DIR/cidrella.db"
  [ -f "$SNAPSHOT_DIR/cidrella.db-wal" ] && cp -a "$SNAPSHOT_DIR/cidrella.db-wal" "$DATA_DIR/cidrella.db-wal" || rm -f "$DATA_DIR/cidrella.db-wal"
  [ -f "$SNAPSHOT_DIR/cidrella.db-shm" ] && cp -a "$SNAPSHOT_DIR/cidrella.db-shm" "$DATA_DIR/cidrella.db-shm" || rm -f "$DATA_DIR/cidrella.db-shm"
  [ -f "$SNAPSHOT_DIR/analytics.duckdb" ] && cp -a "$SNAPSHOT_DIR/analytics.duckdb" "$DATA_DIR/analytics.duckdb"
  chown -R cidrella:cidrella "$DATA_DIR/cidrella.db"* "$DATA_DIR/analytics.duckdb" 2>/dev/null || true
  ok "Database snapshot restored."
  emit_event rollback pass phase=db-restore "dir=$SNAPSHOT_DIR"
fi

info "Swapping symlink: $INSTALL_LINK -> $INACTIVE_SLOT"
ln -sfn "$INACTIVE_SLOT" "$INSTALL_LINK"
emit_event rollback pass phase=symlink-swap "active_slot=$INACTIVE_SLOT"

info "Reloading systemd..."
systemctl daemon-reload

info "Starting CIDRella..."
# Clear the start-limit counter first. This script is run precisely when the
# active version is broken, and a broken version has usually been crashlooping
# under Restart=always, burning StartLimitBurst=5 per StartLimitIntervalSec=60.
# Once that budget is gone systemd refuses the next start with "Start request
# repeated too quickly", and it refuses it for the GOOD slot too, because the
# limit belongs to the UNIT and not to the code the symlink points at. This is
# the manual last line of defense, so it must not be defeated by a rate limit
# the broken version burned through. Observed on testerella 2026-08-19.
systemctl reset-failed cidrella 2>/dev/null || true

# Not fatal: this script runs under `set -euo pipefail`, so a bare start that
# fails would abort here and skip both the readiness wait below and the
# operator-facing failure message that tells them what to do next. Let the
# check below decide.
if ! systemctl start cidrella; then
  warn "systemctl start returned non-zero, checking service state below"
fi

# Wait for service to come up
info "Waiting for service to start..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if systemctl is-active --quiet cidrella; then
    break
  fi
  sleep 1
done

if systemctl is-active --quiet cidrella; then
  echo ""
  ok "Rollback complete. CIDRella v${INACTIVE_VERSION} is running."
  echo ""
  echo -e "  ${BOLD}Active slot:${NC}  $(readlink "$INSTALL_LINK")"
  echo -e "  ${BOLD}Version:${NC}      v${INACTIVE_VERSION}"
  echo -e "  ${BOLD}Logs:${NC}         journalctl -u cidrella -f"
  echo ""
  emit_event rollback end result=success "restored_version=$INACTIVE_VERSION"
else
  err "CIDRella failed to start after rollback!"
  err "Check: journalctl -u cidrella -n 50"
  emit_event rollback end result=service-not-active "restored_version=$INACTIVE_VERSION"
  exit 1
fi
