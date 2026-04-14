#!/bin/bash
set -euo pipefail

# Resolve $0 to an absolute path BEFORE the `cd /` below. Order matters:
# if $0 is a relative path like `./update.sh` (user ran it via cd + ./),
# then `readlink -f` evaluates it against the current cwd. Resolving after
# `cd /` would yield `/update.sh`, and the library-path derivation below
# would produce `//scripts/lib` — the cryptic failure mode that bit prod
# on the v0.4.6→v0.4.8 transition. Capture the realpath first.
_UPDATE_SH_REAL="$(readlink -f "$0" 2>/dev/null || echo "$0")"

# Anchor CWD to / so we never depend on the invoker's working directory.
# Prior incident (2026-04-12): user ran /opt/cidrella/update.sh while cd'd
# inside /opt/cidrella-a; update.sh later rm -rf'd that slot during the
# target-slot wipe, which unlinked the running process's CWD inode. rsync
# then called getcwd() during startup and failed with "No such file or
# directory (code 3)", killing the update at line 380 of v0.4.4. cd / makes
# the script immune to invoker CWD regardless of where it gets called from.
cd / 2>/dev/null || true

# ═══════════════════════════════════════════════════════════
# CIDRella Updater (A/B slot with auto-rollback)
#
# Usage:
#   cidrella-update                            # update to latest
#   cidrella-update --version 0.5.0            # update to specific version
#   cidrella-update --progress-file /path.json # write progress for API consumers
#   cidrella-update --from-api                 # suppress interactive output
#
# Flow:
#   1. Preflight: root, disk space, existing install, detect A/B slots
#   2. Download + verify signature (old version still running)
#   3. Extract to inactive slot (old version still running)
#   4. Pre-flight validate new slot: syntax + spawn on temp port + /api/health/deep
#   5. Snapshot DB (SQLite WAL-checkpointed + DuckDB)
#   6. Install standalone rollback script
#   7. Atomic switchover: swap symlink, daemon-reload, restart
#   8. Verify health — auto-rollback on failure
#
# dnsmasq is NEVER restarted by this script. DNS/DHCP stay up throughout.
# ═══════════════════════════════════════════════════════════

GITHUB_REPO="fatcat/cidrella"
INSTALL_LINK="/opt/cidrella"
SLOT_A="/opt/cidrella-a"
SLOT_B="/opt/cidrella-b"
DATA_DIR="/var/lib/cidrella"
SNAPSHOT_DIR="${DATA_DIR}/snapshots/pre-update"
BUILD_ARCH="linux-x64"
PREFLIGHT_PORT=18443
HEALTH_POLL_SECONDS=20
MIN_FREE_MB=400   # Require 400MB free on /opt for bundled tarballs

REQUESTED_VERSION=""
PROGRESS_FILE=""
FROM_API=false
STARTED_AT=""
CURRENT_VERSION="unknown"
NEW_VERSION=""
TMPDIR=""
RESOLV_BACKUP=""
PREFLIGHT_PID=""
LAST_PHASE="init"
UPDATE_LOG="/var/lib/cidrella/update.log"

# ─── Shared library ───────────────────────────────────────
# Source the per-slot bash helpers. Scripts live in the active slot at
# $INSTALL_LINK/scripts/lib/. $0 was resolved above (before `cd /`) so
# _UPDATE_SH_REAL is an absolute path regardless of how we were invoked:
# `./update.sh`, `/opt/cidrella/update.sh`, or `/usr/local/bin/cidrella-update`
# (a symlink — readlink -f follows it).
_UPDATE_SLOT_DIR="$(dirname "$_UPDATE_SH_REAL")"
LIB_DIR="$_UPDATE_SLOT_DIR/scripts/lib"
# Fallback: if the $0-derived path somehow doesn't point at a valid lib
# (cwd anomaly, broken symlink, future refactor regression), try the
# well-known stable path. INSTALL_LINK is the always-current slot symlink.
if [ ! -d "$LIB_DIR" ] || [ ! -f "$LIB_DIR/log.sh" ]; then
  LIB_DIR="$INSTALL_LINK/scripts/lib"
fi
if [ ! -d "$LIB_DIR" ] || [ ! -f "$LIB_DIR/log.sh" ]; then
  echo "[ERROR] shared library not found at $LIB_DIR" >&2
  echo "[ERROR]   \$0=$0  resolved=$_UPDATE_SH_REAL  INSTALL_LINK=$INSTALL_LINK" >&2
  echo "[ERROR] Try running the absolute path: $INSTALL_LINK/update.sh" >&2
  exit 1
fi
# Must export FROM_API before sourcing log.sh so color/output guards work.
export FROM_API
# shellcheck source=scripts/lib/log.sh
source "$LIB_DIR/log.sh"
# shellcheck source=scripts/lib/slots.sh
source "$LIB_DIR/slots.sh"
# shellcheck source=scripts/lib/verify.sh
source "$LIB_DIR/verify.sh"
# shellcheck source=scripts/lib/systemd-install.sh
source "$LIB_DIR/systemd-install.sh"
# rotation.sh is optional — pre-v0.4.9 slots don't ship it. The rotation
# step is gated on this check at every call site.
if [ -f "$LIB_DIR/rotation.sh" ]; then
  # shellcheck source=scripts/lib/rotation.sh
  source "$LIB_DIR/rotation.sh"
fi

# ─── Canonical invocation nudge ──────────────────────────
# If the user ran update.sh directly (either by path or `./update.sh`)
# rather than through the `cidrella-update` wrapper symlink, point them
# at the canonical command. Both entry points work identically — the
# wrapper is just a symlink to this file — but the wrapper path is what
# install.sh and the docs advertise, and it's the invocation that the
# $0-vs-cwd corner case in pre-v0.4.10 releases handled most reliably.
# Suppress the nudge when running under the API (FROM_API=true), when
# $0 IS already the wrapper path, or when the invocation shape can't be
# determined.
if [ "$FROM_API" != "true" ] && [ "$0" != "/usr/local/bin/cidrella-update" ]; then
  info "Tip: the canonical update command is 'cidrella-update' (a wrapper for this script)."
fi

# Legacy aliases for escape codes still used inline below (bold banners).
BOLD=$'\033[1m'
NC=$'\033[0m'

# ─── Node binary resolver ─────────────────────────────────
# Phase 0 plumbing for Phase 2's bundled-Node release. Prefers a
# slot-local bundled runtime if present; falls back to /usr/bin/node.
# Pass the slot directory whose bundled runtime you want (the
# target slot for preflight, the active slot for DB maintenance).
resolve_node() {
  local slot="${1:-}"
  if [ -n "$slot" ] && [ -x "$slot/runtime/node/bin/node" ]; then
    printf '%s\n' "$slot/runtime/node/bin/node"
    return 0
  fi
  if [ -x "/opt/cidrella/runtime/node/bin/node" ]; then
    printf '%s\n' "/opt/cidrella/runtime/node/bin/node"
    return 0
  fi
  printf '%s\n' "/usr/bin/node"
}

# ─── Progress file helpers ────────────────────────────────

write_progress() {
  local state="$1" pct="$2" message="$3" error="${4:-null}"
  [ -z "$PROGRESS_FILE" ] && return 0
  local error_json
  if [ "$error" = "null" ]; then
    error_json="null"
  else
    local escaped
    escaped=$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g')
    error_json="\"$escaped\""
  fi
  cat > "$PROGRESS_FILE" <<PEOF
{"state":"$state","from_version":"$CURRENT_VERSION","to_version":"${NEW_VERSION:-unknown}","started_at":"$STARTED_AT","updated_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","progress_pct":$pct,"message":"$message","error":$error_json,"pid":$$}
PEOF
  chown cidrella:cidrella "$PROGRESS_FILE" 2>/dev/null || true
}

LAST_PCT=0
track_progress() {
  LAST_PHASE="$1"
  LAST_PCT="$2"
  write_progress "$1" "$2" "$3"
}

# ─── Cleanup trap ─────────────────────────────────────────

cleanup() {
  # Kill preflight process if still alive
  if [ -n "$PREFLIGHT_PID" ] && kill -0 "$PREFLIGHT_PID" 2>/dev/null; then
    kill -TERM "$PREFLIGHT_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$PREFLIGHT_PID" 2>/dev/null || true
  fi
  # Restore resolv.conf if we modified it
  if [ -n "$RESOLV_BACKUP" ] && [ -f "$RESOLV_BACKUP" ]; then
    mv "$RESOLV_BACKUP" /etc/resolv.conf
  fi
  # Clean up temp dir
  [ -n "$TMPDIR" ] && [ -d "$TMPDIR" ] && rm -rf "$TMPDIR"
  # Clean up preflight data dir
  rm -rf /tmp/cidrella-preflight 2>/dev/null || true
}

on_error() {
  # Capture $BASH_COMMAND FIRST before any command in this handler overwrites it.
  local exit_code=$?
  local failed_cmd="${BASH_COMMAND}"
  local line_no="${BASH_LINENO[0]}"
  local phase="${LAST_PHASE:-unknown}"

  # Tiny sleep to let any in-flight tee/stdbuf output flush to the log file
  # before we read its tail. Without this the background tee process can be
  # holding the last few lines in a pipe buffer.
  sleep 0.1

  # Grab the tail of the update log. In --from-api mode we exec'd directly
  # into the file; in CLI mode we exec'd through a tee process so both the
  # terminal and the file see the stream.
  local log_tail=""
  if [ -f "$UPDATE_LOG" ]; then
    log_tail=$(tail -n 12 "$UPDATE_LOG" 2>/dev/null || true)
  fi

  # Build a multi-line error string. The UI UpdatePanel renders `error` as a
  # <p> with white-space: pre-wrap so newlines and indentation survive. The
  # goal: any failure should tell you WHAT failed, WHERE, and WHY without
  # SSHing to the box. See feedback_error_reporting.md for the rationale.
  local error_msg
  error_msg="Update failed during ${phase} phase (line ${line_no}, exit ${exit_code})"$'\n'
  error_msg="${error_msg}Command: ${failed_cmd}"
  if [ -n "$log_tail" ]; then
    error_msg="${error_msg}"$'\n'"Last output:"$'\n'"${log_tail}"
  fi

  err "$error_msg"
  write_progress "failed" "${LAST_PCT:-0}" "Update failed" "$error_msg"
  if command -v emit_event >/dev/null 2>&1; then
    # `failed_cmd` may contain quotes, backslashes, or other characters that
    # break emit_event's naive JSON string building. Strip or replace the
    # problematic chars here so the events.jsonl line stays parseable — the
    # one log line a consumer most needs to read (the failing command) must
    # not produce a JSON parse error. Quotes become single quotes, backslashes
    # become forward slashes, control chars and newlines get stripped.
    local safe_cmd
    safe_cmd="${failed_cmd//\"/\'}"
    safe_cmd="${safe_cmd//\\//}"
    safe_cmd=$(printf '%s' "$safe_cmd" | tr -d '\000-\037')
    emit_event update fail \
      "phase=${phase}" \
      "line=${line_no}" \
      "exit_code=${exit_code}" \
      "command=${safe_cmd}"
  fi
  cleanup
  exit "$exit_code"
}

trap on_error ERR
trap cleanup EXIT

# ─── Parse arguments ──────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --progress-file) PROGRESS_FILE="$2"; shift 2 ;;
    --from-api) FROM_API=true; shift ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# Always capture stdout and stderr to $UPDATE_LOG so the ERR trap can read
# the tail and surface it in the progress file's `error` field. Two modes:
#   --from-api: server spawns with stdio: 'ignore', so we redirect only
#               (no tee needed — there's no terminal to write to anyway).
#   CLI mode:   tee to both the terminal AND the log file so the user still
#               sees interactive progress AND the on_error handler has a
#               log to read from. Prior to v0.4.6 CLI mode didn't populate
#               the log at all, so the rich ERR-trap message was empty on
#               direct invocations — specifically the rsync getcwd() failure
#               from the 2026-04-12 prod incident would have been lost.
mkdir -p "$(dirname "$UPDATE_LOG")" 2>/dev/null || true
: > "$UPDATE_LOG" 2>/dev/null || true
if [ "$FROM_API" = true ]; then
  exec > "$UPDATE_LOG" 2>&1
else
  # stdbuf -oL forces line-buffered output on tee so the log file sees each
  # line as it happens, not after a 4KB buffer fills. Without line buffering
  # the ERR trap can race tee and read an empty/partial log.
  if command -v stdbuf >/dev/null 2>&1; then
    exec > >(stdbuf -oL tee -a "$UPDATE_LOG") 2>&1
  else
    exec > >(tee -a "$UPDATE_LOG") 2>&1
  fi
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit_event update start "started_at=$STARTED_AT" "pid=$$"

# ═══════════════════════════════════════════════════════════
# PHASE 1: PREFLIGHT (old version still running)
# ═══════════════════════════════════════════════════════════

[ "$FROM_API" = false ] && echo -e "\n${BOLD}═══ CIDRella Updater ═══${NC}\n"

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
  write_progress "failed" 0 "Update failed" "Script must be run as root"
  exit 1
fi

if [ ! -e "$INSTALL_LINK" ]; then
  err "CIDRella is not installed at $INSTALL_LINK."
  write_progress "failed" 0 "Update failed" "CIDRella not installed at $INSTALL_LINK"
  exit 1
fi

track_progress "preflight" 2 "Detecting installation layout..."

# ─── Detect / migrate installation layout ─────────────────
# The A/B layout uses /opt/cidrella as a symlink to /opt/cidrella-a or -b.
# Pre-A/B installations have /opt/cidrella as a plain directory — we migrate
# on the first A/B update to avoid a flag-day transition.
if [ ! -L "$INSTALL_LINK" ]; then
  info "Migrating to A/B layout (first-time transition)..."
  # Move current directory to slot A, create symlink
  if [ -d "$SLOT_A" ]; then
    err "Cannot migrate: $SLOT_A already exists but $INSTALL_LINK is not a symlink."
    err "Please resolve manually."
    exit 1
  fi
  mv "$INSTALL_LINK" "$SLOT_A"
  ln -sfn "$SLOT_A" "$INSTALL_LINK"
  systemctl daemon-reload
  ok "Migrated $INSTALL_LINK to A/B layout (active: slot-a)."
fi

# Determine active and target slot
ACTIVE_SLOT="$(readlink -f "$INSTALL_LINK")"
case "$ACTIVE_SLOT" in
  "$SLOT_A") TARGET_SLOT="$SLOT_B" ;;
  "$SLOT_B") TARGET_SLOT="$SLOT_A" ;;
  *)
    err "Active slot is not slot-a or slot-b: $ACTIVE_SLOT"
    exit 1
    ;;
esac

info "Active slot:  $ACTIVE_SLOT"
info "Target slot:  $TARGET_SLOT"

# Read current version (via active slot's node, which may be bundled in future)
if [ -f "$INSTALL_LINK/package.json" ]; then
  ACTIVE_NODE=$(resolve_node "$INSTALL_LINK")
  CURRENT_VERSION=$("$ACTIVE_NODE" -e "console.log(require('$INSTALL_LINK/package.json').version)" 2>/dev/null || echo "unknown")
fi
info "Current version: v${CURRENT_VERSION}"
emit_event preflight pass "from_version=$CURRENT_VERSION" "active_slot=$ACTIVE_SLOT" "target_slot=$TARGET_SLOT"

# ─── Disk space check ────────────────────────────────────
# Need room for: tarball download + extracted tarball + populated target slot
AVAILABLE_MB=$(df -BM /opt | tail -1 | awk '{print $4}' | tr -d 'M')
if [ "$AVAILABLE_MB" -lt "$MIN_FREE_MB" ]; then
  err "Insufficient disk space on /opt: ${AVAILABLE_MB}MB free, need at least ${MIN_FREE_MB}MB."
  write_progress "failed" 2 "Update failed" "Insufficient disk space: ${AVAILABLE_MB}MB free"
  exit 1
fi
info "Disk space: ${AVAILABLE_MB}MB free on /opt (ok)"

# ─── DNS fallback injection ──────────────────────────────
# If /etc/resolv.conf points at localhost (CIDRella itself), we may lose DNS
# if anything in the update flow needs it. Inject a public fallback and
# restore on exit (via cleanup trap).
if grep -qE '^nameserver\s+(127\.|::1|0\.0\.0\.0)' /etc/resolv.conf 2>/dev/null; then
  info "Detected local DNS resolver — injecting fallback (8.8.8.8, 1.1.1.1)..."
  RESOLV_BACKUP="/etc/resolv.conf.cidrella-update.bak"
  cp /etc/resolv.conf "$RESOLV_BACKUP"
  {
    cat "$RESOLV_BACKUP"
    echo "# CIDRella update temporary fallback"
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
  } > /etc/resolv.conf
fi

track_progress "downloading" 5 "Checking for updates..."

# ═══════════════════════════════════════════════════════════
# PHASE 2: FETCH + DOWNLOAD + VERIFY (old version running)
# ═══════════════════════════════════════════════════════════

if [ -n "$REQUESTED_VERSION" ]; then
  TAG="v${REQUESTED_VERSION}"
  RELEASE_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
else
  RELEASE_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
fi

info "Checking for updates..."
RELEASE_JSON=$(curl -fsSL "$RELEASE_URL" 2>/dev/null || true)
if [ -z "$RELEASE_JSON" ]; then
  err "Failed to fetch release info from GitHub."
  write_progress "failed" 5 "Update failed" "Failed to fetch release info from GitHub"
  exit 1
fi

TAG_NAME=$(echo "$RELEASE_JSON" | grep -oP '"tag_name"\s*:\s*"\K[^"]+' | head -1)
NEW_VERSION="${TAG_NAME#v}"

# semver_lt / semver_gt / semver_eq come from scripts/lib/slots.sh.

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  ok "Already running the latest version (v${CURRENT_VERSION})."
  write_progress "completed" 100 "Already up to date" "null"
  exit 0
fi

# Prevent accidental downgrade via the update path. Downgrades must go
# through cidrella-rollback, which is the only path that also restores
# the DB snapshot — otherwise old code will crash on a newer schema.
if [ "$CURRENT_VERSION" != "unknown" ] && semver_lt "$NEW_VERSION" "$CURRENT_VERSION"; then
  err "Refusing to downgrade: v${CURRENT_VERSION} → v${NEW_VERSION}"
  err "Use 'cidrella-rollback' to restore the previous version (with DB snapshot)."
  write_progress "failed" 5 "Downgrade not allowed via update" "Requested v${NEW_VERSION} is older than running v${CURRENT_VERSION}"
  exit 1
fi

# Warn if jumping multiple minor versions — migrations and data format
# changes may accumulate. The update will still run, but the admin should
# read intermediate release notes.
CURRENT_MAJOR_MINOR=$(echo "$CURRENT_VERSION" | awk -F. '{print $1"."$2}')
NEW_MAJOR_MINOR=$(echo "$NEW_VERSION" | awk -F. '{print $1"."$2}')
if [ "$CURRENT_MAJOR_MINOR" != "$NEW_MAJOR_MINOR" ] && [ "$CURRENT_VERSION" != "unknown" ]; then
  # Count minor-version gap
  CURRENT_MINOR=$(echo "$CURRENT_VERSION" | awk -F. '{print $2}')
  NEW_MINOR=$(echo "$NEW_VERSION" | awk -F. '{print $2}')
  CURRENT_MAJOR=$(echo "$CURRENT_VERSION" | awk -F. '{print $1}')
  NEW_MAJOR=$(echo "$NEW_VERSION" | awk -F. '{print $1}')
  if [ "$CURRENT_MAJOR" -ne "$NEW_MAJOR" ] 2>/dev/null || [ $((NEW_MINOR - CURRENT_MINOR)) -gt 1 ] 2>/dev/null; then
    warn "Skipping versions: v${CURRENT_VERSION} → v${NEW_VERSION}"
    warn "We recommend reading release notes for all intermediate versions:"
    warn "  https://github.com/${GITHUB_REPO}/releases"
  fi
fi

info "New version available: v${CURRENT_VERSION} → v${NEW_VERSION}"
track_progress "downloading" 10 "Downloading v${NEW_VERSION}..."

# Find arch-specific tarball URL (new format: cidrella-vX.Y.Z-linux-x64.tar.gz)
TARBALL_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*'"${BUILD_ARCH}"'\.tar\.gz"' | sed 's/"$//' | head -1)
if [ -z "$TARBALL_URL" ]; then
  # Fall back to generic name (pre-bundled-deps releases)
  TARBALL_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.tar\.gz"' | sed 's/"$//' | head -1)
fi
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/cidrella-${TAG_NAME}-${BUILD_ARCH}.tar.gz"
fi
MINISIG_URL="${TARBALL_URL}.minisig"

# Download
info "Downloading: $TARBALL_URL"
TMPDIR=$(mktemp -d)
curl -fsSL "$TARBALL_URL" -o "$TMPDIR/cidrella.tar.gz"
TARBALL_SIZE=$(du -h "$TMPDIR/cidrella.tar.gz" | cut -f1)
ok "Downloaded $TARBALL_SIZE"
emit_event download pass "tag=$TAG_NAME" "size=$TARBALL_SIZE"
track_progress "downloading" 25 "Download complete ($TARBALL_SIZE)"

curl -fsSL "$MINISIG_URL" -o "$TMPDIR/cidrella.tar.gz.minisig" 2>/dev/null || true

# ─── Fetch + apply rotation announcements (v0.4.9+) ─────
#
# Before verifying the tarball, check whether the release carries any new
# rotation announcements signed by the break-glass key. Apply them to the
# local key state so that the subsequent tarball verify uses the CURRENT
# (possibly rotated) primary pubkey. This makes key rotation a transparent
# part of the update flow — existing installs pick up rotation on their
# next update without any admin action.
#
# Gated on rotation.sh being present (pre-v0.4.9 slots don't have it —
# the library was sourced at the top of this script if available).
if declare -F load_key_state >/dev/null 2>&1; then
  load_key_state

  BG_PUB_TMP="$TMPDIR/break-glass.pub"
  if current_break_glass_pubkey_file "$BG_PUB_TMP" >/dev/null; then
    ROT_DIR="$TMPDIR/rotations"
    mkdir -p "$ROT_DIR"
    _rot_names=$(fetch_rotation_announcements "$RELEASE_JSON" "$ROT_DIR" || true)
    if [ -n "$_rot_names" ]; then
      info "Found rotation announcements in this release — applying"
      if ! apply_rotation_announcements "$ROT_DIR" "$BG_PUB_TMP"; then
        err "Rotation announcement verification failed — aborting update"
        write_progress "failed" 28 "Rotation verify failed" "A rotation announcement in this release failed signature verification against the break-glass key. This is a security event. Aborting update."
        exit 1
      fi
    fi
  else
    warn "Break-glass pubkey not available — skipping rotation check"
  fi
fi

# ─── Verify signature ───────────────────────────────────
#
# Resolve the primary pubkey the update.sh was originally hardcoded to
# $INSTALL_LINK/scripts/cidrella.pub, which is the pubkey shipped with the
# CURRENT slot — i.e. the pubkey install.sh had embedded when THIS version
# was installed. That still works for the common no-rotation case, but
# rotation changes the effective trust anchor. Use the resolver from
# rotation.sh if available (which consults .key-state.json first); fall
# back to the shipped file for pre-v0.4.9 slots.
PUBKEY_FILE="$INSTALL_LINK/scripts/cidrella.pub"
if declare -F current_primary_pubkey_file >/dev/null 2>&1; then
  _resolved_pub="$TMPDIR/primary.pub"
  if current_primary_pubkey_file "$_resolved_pub" >/dev/null; then
    PUBKEY_FILE="$_resolved_pub"
  fi
fi
_sig_file="$TMPDIR/cidrella.tar.gz.minisig"
if [ -f "$_sig_file" ] && [ -f "$PUBKEY_FILE" ]; then
  track_progress "verifying" 30 "Verifying signature..."
  emit_event verify start "tarball=$TMPDIR/cidrella.tar.gz"
  if verify_minisign "$TMPDIR/cidrella.tar.gz" "$_sig_file" "$PUBKEY_FILE"; then
    ok "Signature verified."
    emit_event verify pass
  else
    _rc=$?
    if [ "$_rc" -eq 2 ]; then
      warn "minisign not installed — skipping signature verification."
      emit_event verify skip reason=no-minisign
    else
      err "Signature verification failed! The download may be corrupted or tampered with."
      emit_event verify fail reason=bad-signature
      write_progress "failed" 30 "Signature verification failed" "minisign verification failed"
      exit 1
    fi
  fi
elif [ -f "$PUBKEY_FILE" ]; then
  warn "No signature file found for this release. Proceeding without verification."
  emit_event verify skip reason=no-sig-file
else
  warn "minisign not available or no public key — skipping signature verification."
  emit_event verify skip reason=no-pubkey
fi

# ═══════════════════════════════════════════════════════════
# PHASE 3: EXTRACT TO TARGET SLOT (old version still running)
# ═══════════════════════════════════════════════════════════

track_progress "extracting" 40 "Extracting to target slot..."
info "Extracting to $TARGET_SLOT..."

rm -rf "$TARGET_SLOT"
mkdir -p "$TARGET_SLOT"

tar -xzf "$TMPDIR/cidrella.tar.gz" -C "$TMPDIR"
EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "cidrella*" | head -1)
if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "$TMPDIR" ]; then
  err "Unexpected tarball layout — no cidrella-* directory found."
  exit 1
fi
# Copy all files from the extracted directory into the target slot
rsync -a "$EXTRACTED/" "$TARGET_SLOT/"
chown -R cidrella:cidrella "$TARGET_SLOT"
ok "Extracted to $TARGET_SLOT"
emit_event extract pass "target_slot=$TARGET_SLOT"
track_progress "extracting" 50 "Files extracted"

# ─── Verify RELEASE.json and authoritative version ──────
# The GitHub API's tag_name is on the attacker's side of the trust boundary —
# any early version checks we did were advisory. The signed tarball contains
# a RELEASE.json whose version field is the ONLY authoritative version.
# Re-run the downgrade guard here with that value.
RELEASE_META="$TARGET_SLOT/RELEASE.json"
if [ -f "$RELEASE_META" ]; then
  VERIFIED_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RELEASE_META" | head -1)
  if [ -z "$VERIFIED_VERSION" ]; then
    err "RELEASE.json present but missing/malformed 'version' field — aborting"
    emit_event verify fail reason=release-json-malformed
    exit 1
  fi
  if [ "$VERIFIED_VERSION" != "$NEW_VERSION" ]; then
    warn "RELEASE.json version ($VERIFIED_VERSION) differs from GitHub tag ($NEW_VERSION)"
    warn "Using signed RELEASE.json value as authoritative"
    emit_event verify warn reason=tag-mismatch "tag=$NEW_VERSION" "release_json=$VERIFIED_VERSION"
    NEW_VERSION="$VERIFIED_VERSION"
  fi
  # Authoritative downgrade guard — runs on signed data.
  if [ "$CURRENT_VERSION" != "unknown" ] && semver_lt "$NEW_VERSION" "$CURRENT_VERSION"; then
    err "Refusing to downgrade (verified from signed RELEASE.json): v${CURRENT_VERSION} → v${NEW_VERSION}"
    err "Use 'cidrella-rollback' to restore the previous version (with DB snapshot)."
    emit_event verify fail reason=downgrade "from=$CURRENT_VERSION" "to=$NEW_VERSION"
    write_progress "failed" 50 "Downgrade not allowed via update" "Signed RELEASE.json v${NEW_VERSION} is older than running v${CURRENT_VERSION}"
    exit 1
  fi
  ok "RELEASE.json verified: v${VERIFIED_VERSION}"
  emit_event verify pass "release_json_version=$VERIFIED_VERSION"
else
  warn "Tarball has no RELEASE.json — pre-v0.4.3 release; using unverified GitHub tag for version"
  emit_event verify warn reason=no-release-json
fi

# ═══════════════════════════════════════════════════════════
# PHASE 4: PRE-FLIGHT VALIDATION (old version still running)
# ═══════════════════════════════════════════════════════════

track_progress "validating" 55 "Validating new version..."
info "Pre-flight validation..."

# Syntax check
if ! node --check "$TARGET_SLOT/server/src/index.js" 2>/dev/null; then
  err "Pre-flight failed: new server/src/index.js has syntax errors"
  exit 1
fi
ok "Syntax check passed"

# Verify bundled node_modules exist — the new build pipeline bundles them
if [ ! -d "$TARGET_SLOT/server/node_modules/express" ]; then
  warn "Bundled node_modules not found in tarball — running npm install as fallback"
  cd "$TARGET_SLOT/server"
  npm install --omit=dev --silent 2>&1 | tail -3
  cd - >/dev/null
fi

# Verify key native bindings. v0.4.7 dropped bcrypt in favor of bcryptjs
# (pure JS), so that check is gone. Three native bindings remain.
MISSING=""
[ ! -f "$TARGET_SLOT/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] && MISSING="$MISSING better-sqlite3"
[ ! -f "$TARGET_SLOT/server/node_modules/duckdb/lib/binding/duckdb.node" ] && MISSING="$MISSING duckdb"
[ ! -f "$TARGET_SLOT/server/node_modules/raw-socket/build/Release/raw.node" ] && MISSING="$MISSING raw-socket"
if [ -n "$MISSING" ]; then
  err "Pre-flight failed: missing native bindings:$MISSING"
  exit 1
fi
ok "Native bindings present"

# ─── Deep health probe: spawn new version on temp port with isolated data dir ─
track_progress "validating" 60 "Probing new version..."
info "Starting preflight probe on port $PREFLIGHT_PORT (isolated data dir)..."
PREFLIGHT_DATA="/tmp/cidrella-preflight"
rm -rf "$PREFLIGHT_DATA"
mkdir -p "$PREFLIGHT_DATA"
chown cidrella:cidrella "$PREFLIGHT_DATA"

# Start new version on temp port with throwaway data dir — so it doesn't
# touch production DB and we can verify all subsystems come up clean.
PREFLIGHT_NODE=$(resolve_node "$TARGET_SLOT")
sudo -u cidrella env \
  HTTPS_PORT=$PREFLIGHT_PORT \
  HTTP_PORT=$((PREFLIGHT_PORT + 1)) \
  DATA_DIR="$PREFLIGHT_DATA" \
  NODE_ENV=production \
  "$PREFLIGHT_NODE" "$TARGET_SLOT/server/src/index.js" \
  > "$TMPDIR/preflight.log" 2>&1 &
PREFLIGHT_PID=$!

# Wait for the probe endpoint to respond (up to 30 seconds)
PROBE_OK=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if ! kill -0 "$PREFLIGHT_PID" 2>/dev/null; then
    err "Preflight process died during startup"
    tail -30 "$TMPDIR/preflight.log" >&2 || true
    exit 1
  fi
  if curl -sfk "https://127.0.0.1:${PREFLIGHT_PORT}/api/health/deep" -o "$TMPDIR/health.json" 2>/dev/null; then
    if grep -q '"status":"ok"' "$TMPDIR/health.json"; then
      PROBE_OK=true
      break
    fi
  fi
  sleep 1
done

# Kill the preflight process
if kill -0 "$PREFLIGHT_PID" 2>/dev/null; then
  kill -TERM "$PREFLIGHT_PID" 2>/dev/null || true
  sleep 1
  kill -KILL "$PREFLIGHT_PID" 2>/dev/null || true
fi
PREFLIGHT_PID=""
rm -rf "$PREFLIGHT_DATA"

if [ "$PROBE_OK" != true ]; then
  err "Pre-flight health probe failed — new version did not come up cleanly"
  echo "--- preflight log ---" >&2
  tail -30 "$TMPDIR/preflight.log" >&2 || true
  echo "--- health response ---" >&2
  cat "$TMPDIR/health.json" 2>/dev/null || echo "(no response)" >&2
  exit 1
fi
ok "Pre-flight health probe passed"
emit_event preflight pass probe=deep-health "port=$PREFLIGHT_PORT"
track_progress "validating" 70 "Pre-flight validated"

# ═══════════════════════════════════════════════════════════
# PHASE 5: SNAPSHOT DATABASES + INSTALL ROLLBACK (old version running)
# ═══════════════════════════════════════════════════════════

track_progress "snapshotting" 75 "Snapshotting databases..."
info "Snapshotting databases..."

# Make snapshot dir (fresh — discard any previous snapshot)
rm -rf "$SNAPSHOT_DIR"
mkdir -p "$SNAPSHOT_DIR"

# SQLite: checkpoint WAL so the .db file is up to date, then copy
if [ -f "$DATA_DIR/cidrella.db" ]; then
  ACTIVE_NODE=$(resolve_node "$INSTALL_LINK")
  sudo -u cidrella "$ACTIVE_NODE" -e "
    const Database = require('$INSTALL_LINK/server/node_modules/better-sqlite3');
    const db = new Database('$DATA_DIR/cidrella.db');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  " 2>/dev/null || warn "WAL checkpoint failed (may be ok if DB was not in WAL mode)"
  cp -a "$DATA_DIR/cidrella.db" "$SNAPSHOT_DIR/cidrella.db"
  [ -f "$DATA_DIR/cidrella.db-wal" ] && cp -a "$DATA_DIR/cidrella.db-wal" "$SNAPSHOT_DIR/cidrella.db-wal"
  [ -f "$DATA_DIR/cidrella.db-shm" ] && cp -a "$DATA_DIR/cidrella.db-shm" "$SNAPSHOT_DIR/cidrella.db-shm"
fi

if [ -f "$DATA_DIR/analytics.duckdb" ]; then
  cp -a "$DATA_DIR/analytics.duckdb" "$SNAPSHOT_DIR/analytics.duckdb"
fi

# Record metadata
cat > "$SNAPSHOT_DIR/metadata.json" <<META
{
  "from_version": "$CURRENT_VERSION",
  "to_version": "$NEW_VERSION",
  "snapshot_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "previous_slot": "$ACTIVE_SLOT"
}
META
ok "Database snapshots created in $SNAPSHOT_DIR"
emit_event snapshot pass "dir=$SNAPSHOT_DIR"

# ─── Install standalone rollback script ─────────────────
# Copy the rollback script from the CURRENT (running) version, not the new one.
# This ensures the rollback script is always known-good code.
if [ -f "$ACTIVE_SLOT/scripts/rollback.sh" ]; then
  cp "$ACTIVE_SLOT/scripts/rollback.sh" /usr/local/bin/cidrella-rollback
  chmod +x /usr/local/bin/cidrella-rollback
  ok "Rollback script installed at /usr/local/bin/cidrella-rollback"
else
  # First time upgrading to a version that has rollback.sh — use the new one
  if [ -f "$TARGET_SLOT/scripts/rollback.sh" ]; then
    cp "$TARGET_SLOT/scripts/rollback.sh" /usr/local/bin/cidrella-rollback
    chmod +x /usr/local/bin/cidrella-rollback
    warn "Installed rollback.sh from NEW version (current version did not have one)"
  fi
fi

track_progress "snapshotting" 80 "Snapshot complete"

# ═══════════════════════════════════════════════════════════
# PHASE 6: ATOMIC SWITCHOVER (brief Node.js downtime)
# ═══════════════════════════════════════════════════════════

track_progress "switching" 85 "Switching to new version..."
info "Switching to new version..."

# Install cidrella-node wrapper from new slot BEFORE systemd unit update.
# v0.4.3+ systemd units use /usr/local/bin/cidrella-node as ExecStart — the
# wrapper must exist before daemon-reload or the restart will fail.
if [ -f "$TARGET_SLOT/scripts/cidrella-node" ]; then
  install -m 0755 "$TARGET_SLOT/scripts/cidrella-node" /usr/local/bin/cidrella-node
  ok "Installed /usr/local/bin/cidrella-node wrapper"
fi

# Install cidrella-dnsmasq-hup wrapper from new slot (v0.4.6+). Pairs with
# the narrowed sudoers rule that replaced the old permissive kill -HUP rule.
if [ -f "$TARGET_SLOT/scripts/cidrella-dnsmasq-hup" ]; then
  install -m 0755 -o root -g root "$TARGET_SLOT/scripts/cidrella-dnsmasq-hup" /usr/local/bin/cidrella-dnsmasq-hup
  ok "Installed /usr/local/bin/cidrella-dnsmasq-hup wrapper"
fi

# Install cidrella-reset-password wrapper (v0.4.8+). Root-only (0700).
if [ -f "$TARGET_SLOT/scripts/cidrella-reset-password" ]; then
  install -m 0700 -o root -g root "$TARGET_SLOT/scripts/cidrella-reset-password" /usr/local/bin/cidrella-reset-password
  ok "Installed /usr/local/bin/cidrella-reset-password wrapper"
fi

# Apply capabilities to the bundled Node binary in the TARGET slot before
# the symlink swap. v0.4.7+ ships Node in runtime/node/bin/node inside each
# slot; tar doesn't preserve security.capability xattrs, so we re-apply here
# at every update. Target the slot explicitly (not /opt/cidrella) so the
# caps are set on the NEW binary before it becomes active. If the tarball
# has no bundled runtime (pre-0.4.7 release used on a v0.4.7+ host), fall
# through to the existing system-node path — which will only exist on
# legacy installs since v0.4.7 drops system Node from the apt list.
TARGET_NODE_BIN="$TARGET_SLOT/runtime/node/bin/node"
if [ -x "$TARGET_NODE_BIN" ]; then
  if setcap cap_net_raw,cap_net_bind_service+ep "$TARGET_NODE_BIN" 2>/dev/null; then
    ok "Set capabilities on bundled Node ($TARGET_NODE_BIN)"
    emit_event switchover pass setcap=bundled-node "path=$TARGET_NODE_BIN"
  else
    warn "Could not set capabilities on $TARGET_NODE_BIN"
    emit_event switchover warn setcap=failed "path=$TARGET_NODE_BIN"
  fi
fi

# Update systemd unit files if they changed (install_systemd_unit is idempotent).
if [ -f "$TARGET_SLOT/scripts/systemd/cidrella.service" ]; then
  if [ "$(install_systemd_unit "$TARGET_SLOT/scripts/systemd/cidrella.service" /etc/systemd/system/cidrella.service)" = "changed" ]; then
    ok "Updated cidrella.service"
    emit_event switchover pass unit=cidrella.service
  fi
fi
if [ -f "$TARGET_SLOT/scripts/systemd/cidrella-anomaly.service" ] && [ -f /etc/systemd/system/cidrella-anomaly.service ]; then
  if [ "$(install_systemd_unit "$TARGET_SLOT/scripts/systemd/cidrella-anomaly.service" /etc/systemd/system/cidrella-anomaly.service)" = "changed" ]; then
    emit_event switchover pass unit=cidrella-anomaly.service
  fi
fi
# Note: cidrella-dnsmasq.service is deliberately NOT touched — dnsmasq keeps running.

# Update sudoers if present
if [ -f "$TARGET_SLOT/scripts/sudoers/cidrella" ]; then
  cp "$TARGET_SLOT/scripts/sudoers/cidrella" /etc/sudoers.d/cidrella
  chmod 440 /etc/sudoers.d/cidrella
fi

# Update cidrella-update symlink to the target slot's update.sh
if [ -f "$TARGET_SLOT/update.sh" ]; then
  chmod +x "$TARGET_SLOT/update.sh"
  ln -sf "$INSTALL_LINK/update.sh" /usr/local/bin/cidrella-update
fi

# ATOMIC SWITCHOVER: swap symlink
ln -sfn "$TARGET_SLOT" "$INSTALL_LINK"
emit_event switchover pass "active_slot=$TARGET_SLOT"

# Reload systemd so it sees the new target (unit files are absolute paths
# through the symlink, but daemon-reload is cheap insurance).
systemctl daemon-reload

track_progress "switching" 90 "Restarting CIDRella..."
info "Restarting cidrella service (dnsmasq stays running)..."
systemctl restart cidrella

# Restore any enabled-but-inactive auxiliary services after the switchover.
# On 2026-04-12 prod had cidrella-anomaly stopped (cause unknown) and the
# prior update path left it that way — the UI showed stale-green health and
# anomaly detection was silently dead. Explicitly check each auxiliary unit
# that ships with CIDRella: if the unit is enabled but not active, start it.
# Missing units (e.g. dnsmasq mode=include) are silently skipped.
for _aux in cidrella-anomaly; do
  if systemctl list-unit-files "${_aux}.service" >/dev/null 2>&1 \
     && systemctl is-enabled --quiet "$_aux" 2>/dev/null \
     && ! systemctl is-active --quiet "$_aux" 2>/dev/null; then
    info "Starting $_aux (was enabled but inactive)..."
    systemctl start "$_aux" || warn "Failed to start $_aux (non-fatal)"
    emit_event switchover pass "unit=${_aux}.service" action=started
  fi
done

# ═══════════════════════════════════════════════════════════
# PHASE 7: VERIFY HEALTH — auto-rollback on failure
# ═══════════════════════════════════════════════════════════

track_progress "verifying" 93 "Verifying new version..."
info "Verifying new version..."

VERIFY_OK=false
for i in $(seq 1 "$HEALTH_POLL_SECONDS"); do
  if systemctl is-active --quiet cidrella; then
    # Service is up; probe /api/health/deep via loopback
    if curl -sfk https://127.0.0.1:8443/api/health/deep -o "$TMPDIR/verify.json" 2>/dev/null; then
      if grep -q '"status":"ok"' "$TMPDIR/verify.json"; then
        VERIFY_OK=true
        break
      fi
    fi
  fi
  sleep 1
done

if [ "$VERIFY_OK" = true ]; then
  ok "New version healthy."
  emit_event health pass "version=$NEW_VERSION"

  # Tighten secret file permissions (v0.4.8+). Logic lives in
  # scripts/lib/tighten-secrets.sh so install.sh and update.sh share one
  # source of truth. Idempotent — safe to run on every update. Fixes pre-
  # v0.4.8 installs that had 644 cidrella.db and server.key on disk.
  if [ -f "$INSTALL_LINK/scripts/lib/tighten-secrets.sh" ]; then
    # shellcheck source=scripts/lib/tighten-secrets.sh
    source "$INSTALL_LINK/scripts/lib/tighten-secrets.sh"
    tighten_secrets "$DATA_DIR"
    ok "Tightened secret file permissions"
    emit_event switchover pass action=tightened-secrets
  fi

  # Run the incoming release's post-install hook (v0.4.9+). The hook is
  # authored by THIS release (the one whose slot we just switched to) and
  # handles any one-shot setup specific to the new version — wrapper
  # installs, chmod passes, setting seeds, etc. This breaks the recurring
  # pattern where new post-install steps in the incoming update.sh got
  # silently skipped because the outgoing update.sh predated them.
  #
  # The hook is called AFTER the symlink swap and health check passes, so
  # TARGET_SLOT is now the active slot and errors here don't trigger
  # auto-rollback (rollback is harder at this point). The hook is expected
  # to be idempotent and to warn-and-continue on non-fatal errors.
  POST_INSTALL_HOOK="$TARGET_SLOT/scripts/post-install.sh"
  if [ -f "$POST_INSTALL_HOOK" ]; then
    info "Running post-install hook from new slot..."
    if TARGET_SLOT="$TARGET_SLOT" PREV_SLOT="$ACTIVE_SLOT" \
       DATA_DIR="$DATA_DIR" NEW_VERSION="$NEW_VERSION" \
       OLD_VERSION="$CURRENT_VERSION" IS_FRESH_INSTALL=0 \
       bash "$POST_INSTALL_HOOK"; then
      ok "Post-install hook completed"
      emit_event switchover pass action=post-install-hook
    else
      warn "Post-install hook exited non-zero (update continues)"
      emit_event switchover warn action=post-install-hook-failed
    fi
  fi

  emit_event update end "from=$CURRENT_VERSION" "to=$NEW_VERSION" result=success
  track_progress "completed" 100 "Updated to v${NEW_VERSION}"

  if [ "$FROM_API" = false ]; then
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════${NC}"
    echo -e "${BOLD}  CIDRella updated: v${CURRENT_VERSION} → v${NEW_VERSION}${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}Active slot:${NC}  $TARGET_SLOT"
    echo -e "  ${BOLD}Previous:${NC}    $ACTIVE_SLOT (rollback target)"
    echo -e "  ${BOLD}Rollback:${NC}    cidrella-rollback"
    echo -e "  ${BOLD}Logs:${NC}        journalctl -u cidrella -f"
    echo ""
  fi
  exit 0
fi

# ═══════════════════════════════════════════════════════════
# AUTO-ROLLBACK — new version failed to come up
# ═══════════════════════════════════════════════════════════

err "New version failed health check — auto-rolling back to v${CURRENT_VERSION}"
emit_event health fail "version=$NEW_VERSION"
emit_event rollback start "from=$NEW_VERSION" "to=$CURRENT_VERSION"
write_progress "rolling_back" 95 "New version failed — auto-rolling back..." "Health check failed"

# Swap symlink back
ln -sfn "$ACTIVE_SLOT" "$INSTALL_LINK"

# Restore DB snapshots
if [ -f "$SNAPSHOT_DIR/cidrella.db" ]; then
  cp -a "$SNAPSHOT_DIR/cidrella.db" "$DATA_DIR/cidrella.db"
  [ -f "$SNAPSHOT_DIR/cidrella.db-wal" ] && cp -a "$SNAPSHOT_DIR/cidrella.db-wal" "$DATA_DIR/cidrella.db-wal" || rm -f "$DATA_DIR/cidrella.db-wal"
  [ -f "$SNAPSHOT_DIR/cidrella.db-shm" ] && cp -a "$SNAPSHOT_DIR/cidrella.db-shm" "$DATA_DIR/cidrella.db-shm" || rm -f "$DATA_DIR/cidrella.db-shm"
  chown -R cidrella:cidrella "$DATA_DIR/cidrella.db"* 2>/dev/null || true
fi
if [ -f "$SNAPSHOT_DIR/analytics.duckdb" ]; then
  cp -a "$SNAPSHOT_DIR/analytics.duckdb" "$DATA_DIR/analytics.duckdb"
  chown cidrella:cidrella "$DATA_DIR/analytics.duckdb" 2>/dev/null || true
fi

systemctl daemon-reload
systemctl restart cidrella

# Verify rollback worked
ROLLBACK_OK=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if systemctl is-active --quiet cidrella; then
    ROLLBACK_OK=true
    break
  fi
  sleep 1
done

if [ "$ROLLBACK_OK" = true ]; then
  err "Update FAILED — automatically rolled back to v${CURRENT_VERSION}."
  err "Check logs: journalctl -u cidrella -n 100"
  emit_event rollback pass "restored_version=$CURRENT_VERSION"
  emit_event update end result=rolled-back "from=$CURRENT_VERSION" "to=$NEW_VERSION"
  write_progress "failed" 100 "Update failed — rolled back to v${CURRENT_VERSION}" "Health check failed after update. Automatic rollback succeeded."
  exit 1
else
  err "CRITICAL: rollback FAILED too! CIDRella is not running."
  err "Run: cidrella-rollback --yes"
  err "Or manually: ln -sfn $ACTIVE_SLOT $INSTALL_LINK && systemctl restart cidrella"
  emit_event rollback fail reason=service-down
  emit_event update end result=catastrophic-failure "from=$CURRENT_VERSION" "to=$NEW_VERSION"
  write_progress "failed" 100 "Update AND rollback failed" "Update failed health check. Automatic rollback also failed."
  exit 1
fi
