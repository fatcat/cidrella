#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# CIDRella Updater
# Updates an existing native CIDRella installation
#
# Usage:
#   cidrella-update                            # update to latest
#   cidrella-update --version 0.2.0            # update to specific version
#   cidrella-update --progress-file /path.json # write progress for API consumers
#   cidrella-update --from-api                 # suppress interactive output
# ═══════════════════════════════════════════════════════════

GITHUB_REPO="fatcat/cidrella"
INSTALL_DIR="/opt/cidrella"
DATA_DIR="/var/lib/cidrella"
REQUESTED_VERSION=""
PROGRESS_FILE=""
FROM_API=false
STARTED_AT=""
CURRENT_VERSION="unknown"
NEW_VERSION=""
BACKUP_DIR=""

# ─── Colors (suppressed in API mode) ─────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { [ "$FROM_API" = true ] && return; echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { [ "$FROM_API" = true ] && return; echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { [ "$FROM_API" = true ] && return; echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Progress file helpers ────────────────────────────────

write_progress() {
  local state="$1" pct="$2" message="$3" error="${4:-null}"
  [ -z "$PROGRESS_FILE" ] && return 0

  # Quote strings, pass null literally
  local error_json
  if [ "$error" = "null" ]; then
    error_json="null"
  else
    # Escape quotes and backslashes in error message
    local escaped
    escaped=$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g')
    error_json="\"$escaped\""
  fi

  local backup_json
  if [ -n "$BACKUP_DIR" ]; then
    backup_json="\"$BACKUP_DIR\""
  else
    backup_json="null"
  fi

  cat > "$PROGRESS_FILE" <<PEOF
{"state":"$state","from_version":"$CURRENT_VERSION","to_version":"${NEW_VERSION:-unknown}","started_at":"$STARTED_AT","updated_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","progress_pct":$pct,"message":"$message","error":$error_json,"backup_path":$backup_json,"pid":$$}
PEOF
  chown cidrella:cidrella "$PROGRESS_FILE" 2>/dev/null || true
}

# ─── Error trap ───────────────────────────────────────────

on_error() {
  local exit_code=$?
  local line_no="${BASH_LINENO[0]}"
  local error_msg="Update failed at line $line_no (exit code $exit_code)"
  err "$error_msg"
  write_progress "failed" "${LAST_PCT:-0}" "Update failed" "$error_msg"
  exit "$exit_code"
}
trap on_error ERR

LAST_PCT=0
track_progress() {
  LAST_PCT="$2"
  write_progress "$1" "$2" "$3"
}

# ─── Parse arguments ──────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --progress-file) PROGRESS_FILE="$2"; shift 2 ;;
    --from-api) FROM_API=true; shift ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ═══════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════

[ "$FROM_API" = false ] && echo -e "\n${BOLD}═══ CIDRella Updater ═══${NC}\n"

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
  write_progress "failed" 0 "Update failed" "Script must be run as root"
  exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
  err "CIDRella is not installed at $INSTALL_DIR."
  write_progress "failed" 0 "Update failed" "CIDRella not installed at $INSTALL_DIR"
  exit 1
fi

# Current version
if [ -f "$INSTALL_DIR/package.json" ]; then
  CURRENT_VERSION=$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "unknown")
fi
info "Current version: v${CURRENT_VERSION}"

track_progress "downloading" 5 "Checking for updates..."

# ═══════════════════════════════════════════════════════════
# FETCH LATEST RELEASE
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

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  ok "Already running the latest version (v${CURRENT_VERSION})."
  write_progress "completed" 100 "Already up to date" "null"
  exit 0
fi

info "New version available: v${CURRENT_VERSION} → v${NEW_VERSION}"
track_progress "downloading" 10 "Downloading v${NEW_VERSION}..."

# Find tarball URL
TARBALL_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.tar\.gz"' | sed 's/"$//' | head -1)
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/cidrella-${TAG_NAME}.tar.gz"
fi

# Find minisig URL (signature file)
MINISIG_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.minisig"' | sed 's/"$//' | head -1)
if [ -z "$MINISIG_URL" ]; then
  MINISIG_URL="${TARBALL_URL}.minisig"
fi

# ═══════════════════════════════════════════════════════════
# DOWNLOAD
# ═══════════════════════════════════════════════════════════

info "Downloading v${NEW_VERSION}..."
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'; on_error" ERR
trap "rm -rf '$TMPDIR'" EXIT

curl -fsSL "$TARBALL_URL" -o "$TMPDIR/cidrella.tar.gz"
track_progress "downloading" 25 "Download complete"

# Download signature file
curl -fsSL "$MINISIG_URL" -o "$TMPDIR/cidrella.tar.gz.minisig" 2>/dev/null || true

# ═══════════════════════════════════════════════════════════
# VERIFY SIGNATURE
# ═══════════════════════════════════════════════════════════

PUBKEY_FILE="$INSTALL_DIR/scripts/cidrella.pub"

if [ -f "$TMPDIR/cidrella.tar.gz.minisig" ] && [ -f "$PUBKEY_FILE" ] && command -v minisign &>/dev/null; then
  track_progress "verifying" 30 "Verifying signature..."
  if minisign -Vm "$TMPDIR/cidrella.tar.gz" -p "$PUBKEY_FILE" >/dev/null 2>&1; then
    ok "Signature verified."
    track_progress "verifying" 35 "Signature verified"
  else
    err "Signature verification failed! The download may be corrupted or tampered with."
    write_progress "failed" 30 "Signature verification failed" "minisign verification failed — tarball may be corrupted or tampered"
    exit 1
  fi
elif [ -f "$PUBKEY_FILE" ] && command -v minisign &>/dev/null; then
  warn "No signature file found for this release. Proceeding without verification."
  track_progress "verifying" 35 "No signature file — skipping verification"
else
  warn "minisign not available or no public key — skipping signature verification."
  track_progress "verifying" 35 "Signature verification not available"
fi

# ═══════════════════════════════════════════════════════════
# BACKUP
# ═══════════════════════════════════════════════════════════

track_progress "backing_up" 40 "Creating backup..."

BACKUP_DIR="${INSTALL_DIR}.bak-$(date +%Y%m%d%H%M)"
info "Backing up current installation to ${BACKUP_DIR}..."
cp -a "$INSTALL_DIR" "$BACKUP_DIR"
ok "Backup created."

track_progress "backing_up" 45 "Backup created at ${BACKUP_DIR}"

# ═══════════════════════════════════════════════════════════
# EXTRACT
# ═══════════════════════════════════════════════════════════

track_progress "extracting" 50 "Extracting files..."

tar -xzf "$TMPDIR/cidrella.tar.gz" -C "$TMPDIR"

EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "cidrella*" | head -1)
if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "$TMPDIR" ]; then
  EXTRACTED="$TMPDIR"
fi

rsync -a --delete "$EXTRACTED/" "$INSTALL_DIR/"
ok "Extracted to $INSTALL_DIR"

track_progress "extracting" 60 "Files extracted"

# ═══════════════════════════════════════════════════════════
# INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════

track_progress "installing_deps" 65 "Installing dependencies..."

info "Installing dependencies..."
cd "$INSTALL_DIR/server"
npm install --production --silent 2>&1 | tail -5
ok "Dependencies installed."

track_progress "installing_deps" 75 "Dependencies installed"

# ═══════════════════════════════════════════════════════════
# UPDATE SYSTEMD UNITS
# ═══════════════════════════════════════════════════════════

track_progress "updating_services" 80 "Updating system services..."

UNITS_UPDATED=false

if [ -f "$INSTALL_DIR/scripts/systemd/cidrella.service" ]; then
  if ! diff -q "$INSTALL_DIR/scripts/systemd/cidrella.service" /etc/systemd/system/cidrella.service &>/dev/null; then
    cp "$INSTALL_DIR/scripts/systemd/cidrella.service" /etc/systemd/system/
    UNITS_UPDATED=true
    ok "Updated cidrella.service"
  fi
fi

if [ -f "$INSTALL_DIR/scripts/systemd/cidrella-dnsmasq.service" ] && [ -f /etc/systemd/system/cidrella-dnsmasq.service ]; then
  if ! diff -q "$INSTALL_DIR/scripts/systemd/cidrella-dnsmasq.service" /etc/systemd/system/cidrella-dnsmasq.service &>/dev/null; then
    cp "$INSTALL_DIR/scripts/systemd/cidrella-dnsmasq.service" /etc/systemd/system/
    UNITS_UPDATED=true
    ok "Updated cidrella-dnsmasq.service"
  fi
fi

if [ "$UNITS_UPDATED" = true ]; then
  systemctl daemon-reload
fi

# Update sudoers if present
if [ -f "$INSTALL_DIR/scripts/sudoers/cidrella" ]; then
  cp "$INSTALL_DIR/scripts/sudoers/cidrella" /etc/sudoers.d/cidrella
  chmod 440 /etc/sudoers.d/cidrella
fi

track_progress "updating_services" 85 "System services updated"

# ═══════════════════════════════════════════════════════════
# RESTART SERVICES
# ═══════════════════════════════════════════════════════════

track_progress "restarting" 90 "Restarting services..."

info "Restarting services..."

if systemctl is-enabled --quiet cidrella-dnsmasq 2>/dev/null; then
  systemctl restart cidrella-dnsmasq
  ok "cidrella-dnsmasq restarted."
fi

# Write near-final progress before restarting the main service
# (after this point, the Node.js process will be killed)
track_progress "restarting" 95 "Restarting CIDRella..."

systemctl restart cidrella

# Wait for startup
sleep 2

if systemctl is-active --quiet cidrella; then
  ok "CIDRella is running!"
  write_progress "completed" 100 "Updated to v${NEW_VERSION}"
else
  warn "CIDRella may not have started correctly."
  warn "Check logs: journalctl -u cidrella -f"
  warn "To rollback: cp -a ${BACKUP_DIR}/* ${INSTALL_DIR}/ && systemctl restart cidrella"
  write_progress "failed" 95 "Service failed to start after update" "CIDRella did not start after restart. Rollback: cp -a ${BACKUP_DIR}/* ${INSTALL_DIR}/ && systemctl restart cidrella"
  exit 1
fi

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════

if [ "$FROM_API" = false ]; then
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════${NC}"
  echo -e "${BOLD}  CIDRella updated: v${CURRENT_VERSION} → v${NEW_VERSION}${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BOLD}Backup:${NC} ${BACKUP_DIR}"
  echo -e "  ${BOLD}Logs:${NC}   journalctl -u cidrella -f"
  echo ""
  info "Database migrations run automatically on startup."
  echo ""
fi
