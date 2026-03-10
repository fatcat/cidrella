#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# CIDRella Updater
# Updates an existing native CIDRella installation
#
# Usage:
#   cidrella-update              # update to latest
#   cidrella-update --version 0.2.0  # update to specific version
# ═══════════════════════════════════════════════════════════

GITHUB_REPO="mcnultyd/cidrella"
INSTALL_DIR="/opt/cidrella"
DATA_DIR="/var/lib/cidrella"
REQUESTED_VERSION=""

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Parse arguments ──────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════

echo -e "\n${BOLD}═══ CIDRella Updater ═══${NC}\n"

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
  exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
  err "CIDRella is not installed at $INSTALL_DIR."
  err "Run the install script first."
  exit 1
fi

# Current version
CURRENT_VERSION="unknown"
if [ -f "$INSTALL_DIR/package.json" ]; then
  CURRENT_VERSION=$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "unknown")
fi
info "Current version: v${CURRENT_VERSION}"

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
  exit 1
fi

TAG_NAME=$(echo "$RELEASE_JSON" | grep -oP '"tag_name"\s*:\s*"\K[^"]+' | head -1)
NEW_VERSION="${TAG_NAME#v}"

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  ok "Already running the latest version (v${CURRENT_VERSION})."
  exit 0
fi

info "New version available: v${CURRENT_VERSION} → v${NEW_VERSION}"

# Find tarball
TARBALL_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.tar\.gz' | head -1)
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/cidrella-${TAG_NAME}.tar.gz"
fi

# ═══════════════════════════════════════════════════════════
# BACKUP
# ═══════════════════════════════════════════════════════════

BACKUP_DIR="${INSTALL_DIR}.bak-$(date +%Y%m%d%H%M)"
info "Backing up current installation to ${BACKUP_DIR}..."
cp -a "$INSTALL_DIR" "$BACKUP_DIR"
ok "Backup created."

# ═══════════════════════════════════════════════════════════
# DOWNLOAD & EXTRACT
# ═══════════════════════════════════════════════════════════

info "Downloading v${NEW_VERSION}..."
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

curl -fsSL "$TARBALL_URL" -o "$TMPDIR/cidrella.tar.gz"
tar -xzf "$TMPDIR/cidrella.tar.gz" -C "$TMPDIR"

EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "cidrella*" | head -1)
if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "$TMPDIR" ]; then
  EXTRACTED="$TMPDIR"
fi

rsync -a --delete "$EXTRACTED/" "$INSTALL_DIR/"
ok "Extracted to $INSTALL_DIR"

# ═══════════════════════════════════════════════════════════
# INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════

info "Installing dependencies..."
cd "$INSTALL_DIR/server"
npm install --production --silent 2>&1 | tail -5
ok "Dependencies installed."

# ═══════════════════════════════════════════════════════════
# UPDATE SYSTEMD UNITS
# ═══════════════════════════════════════════════════════════

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

# ═══════════════════════════════════════════════════════════
# RESTART SERVICES
# ═══════════════════════════════════════════════════════════

info "Restarting services..."

if systemctl is-enabled --quiet cidrella-dnsmasq 2>/dev/null; then
  systemctl restart cidrella-dnsmasq
  ok "cidrella-dnsmasq restarted."
fi

systemctl restart cidrella
ok "cidrella restarted."

# Wait for startup
sleep 2

if systemctl is-active --quiet cidrella; then
  ok "CIDRella is running!"
else
  warn "CIDRella may not have started correctly."
  warn "Check logs: journalctl -u cidrella -f"
  warn "To rollback: cp -a ${BACKUP_DIR}/* ${INSTALL_DIR}/ && systemctl restart cidrella"
  exit 1
fi

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════

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
