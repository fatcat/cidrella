#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# CIDRella LXC Dev Deployer
# Syncs local dev tree to the LXC host, builds, and restarts.
#
# Usage:
#   ./scripts/deploy-lxc.sh              # full deploy
#   ./scripts/deploy-lxc.sh --skip-build # skip client build (server-only changes)
#   ./scripts/deploy-lxc.sh --host 10.0.3.100  # override target host
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LXC_HOST="10.0.3.250"
LXC_USER="root"
INSTALL_DIR="/opt/cidrella"
DATA_DIR="/var/lib/cidrella"
SKIP_BUILD=false

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
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Parse arguments ──────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --host) LXC_HOST="$2"; shift 2 ;;
    --user) LXC_USER="$2"; shift 2 ;;
    *) err "Unknown argument: $1" ;;
  esac
done

SSH_TARGET="${LXC_USER}@${LXC_HOST}"

echo -e "\n${BOLD}═══ CIDRella LXC Deploy ═══${NC}\n"

# ═══════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════

info "Target: ${SSH_TARGET}:${INSTALL_DIR}"

# Verify SSH connectivity
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_TARGET" true 2>/dev/null; then
  err "Cannot connect to ${SSH_TARGET}. Check SSH config and keys."
fi
ok "SSH connection verified."

# ═══════════════════════════════════════════════════════════
# BUILD CLIENT (local)
# ═══════════════════════════════════════════════════════════

if [ "$SKIP_BUILD" = false ]; then
  info "Building client locally..."
  cd "$PROJECT_DIR/client"
  npx vite build --emptyOutDir 2>&1 | grep -v 'chunks are larger\|dynamic import()\|manualChunks\|chunkSizeWarningLimit' | tail -3
  ok "Client built."
  cd "$PROJECT_DIR"
else
  warn "Skipping client build (--skip-build)."
fi

# ═══════════════════════════════════════════════════════════
# STOP SERVICES
# ═══════════════════════════════════════════════════════════

info "Stopping services on LXC..."
ssh "$SSH_TARGET" "systemctl stop cidrella-anomaly cidrella cidrella-dnsmasq 2>/dev/null || true"
ok "Services stopped."

# ═══════════════════════════════════════════════════════════
# SYNC FILES
# ═══════════════════════════════════════════════════════════

info "Syncing files to LXC..."

# Server source
rsync -az --delete \
  --exclude='node_modules' \
  "$PROJECT_DIR/server/" "${SSH_TARGET}:${INSTALL_DIR}/server/"

# Built client
rsync -az --delete \
  "$PROJECT_DIR/client/dist/" "${SSH_TARGET}:${INSTALL_DIR}/client/dist/"

# dnsmasq config templates
rsync -az --delete \
  "$PROJECT_DIR/dnsmasq/" "${SSH_TARGET}:${INSTALL_DIR}/dnsmasq/"

# Scripts
rsync -az --delete \
  "$PROJECT_DIR/scripts/" "${SSH_TARGET}:${INSTALL_DIR}/scripts/"

# Root package.json (version source)
rsync -az "$PROJECT_DIR/package.json" "${SSH_TARGET}:${INSTALL_DIR}/package.json"

ok "Files synced."

# ═══════════════════════════════════════════════════════════
# INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════

info "Installing server dependencies..."
ssh "$SSH_TARGET" "
  # Ensure DNS works while dnsmasq is down
  if ! host -W 2 registry.npmjs.org >/dev/null 2>&1; then
    echo 'nameserver 9.9.9.9' > /etc/resolv.conf
  fi
  cd ${INSTALL_DIR}/server && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
"
ok "Dependencies installed."

info "Installing Python ML dependencies..."
ssh "$SSH_TARGET" "
  if [ -f ${INSTALL_DIR}/server/anomaly/requirements.txt ]; then
    # Ensure pip is available
    if ! command -v pip3 &>/dev/null; then
      apt-get update -qq && apt-get install -y -qq python3-pip python3-dev >/dev/null 2>&1
    fi
    pip3 install --break-system-packages --root-user-action=ignore -q -r ${INSTALL_DIR}/server/anomaly/requirements.txt 2>&1 | tail -5
  fi
"
ok "Python dependencies installed."

# ═══════════════════════════════════════════════════════════
# FIX PERMISSIONS
# ═══════════════════════════════════════════════════════════

info "Fixing permissions..."
ssh "$SSH_TARGET" "chown -R cidrella:cidrella ${INSTALL_DIR} ${DATA_DIR}"
ok "Permissions set."

# Ensure Node.js has required capabilities
ssh "$SSH_TARGET" "setcap cap_net_raw,cap_net_bind_service+ep \$(readlink -f \$(which node)) 2>/dev/null || true"

# ═══════════════════════════════════════════════════════════
# UPDATE SYSTEMD & SUDOERS
# ═══════════════════════════════════════════════════════════

UNITS_UPDATED=false

# Compare and update systemd units
for UNIT in cidrella.service cidrella-dnsmasq.service cidrella-anomaly.service; do
  SRC="${INSTALL_DIR}/scripts/systemd/${UNIT}"
  DST="/etc/systemd/system/${UNIT}"
  CHANGED=$(ssh "$SSH_TARGET" "
    if [ -f ${SRC} ] && [ -f ${DST} ]; then
      diff -q ${SRC} ${DST} >/dev/null 2>&1 && echo no || echo yes
    elif [ -f ${SRC} ]; then
      echo yes
    else
      echo no
    fi
  ")
  if [ "$CHANGED" = "yes" ]; then
    ssh "$SSH_TARGET" "cp ${SRC} ${DST}"
    UNITS_UPDATED=true
    ok "Updated ${UNIT}"
  fi
done

if [ "$UNITS_UPDATED" = true ]; then
  ssh "$SSH_TARGET" "systemctl daemon-reload"
fi

# Update sudoers
ssh "$SSH_TARGET" "
  if [ -f ${INSTALL_DIR}/scripts/sudoers/cidrella ]; then
    cp ${INSTALL_DIR}/scripts/sudoers/cidrella /etc/sudoers.d/cidrella
    chmod 440 /etc/sudoers.d/cidrella
  fi
"

# ═══════════════════════════════════════════════════════════
# START SERVICES
# ═══════════════════════════════════════════════════════════

info "Starting services..."
ssh "$SSH_TARGET" "systemctl start cidrella-dnsmasq cidrella"

# Enable and start anomaly service if the unit file exists
ssh "$SSH_TARGET" "
  if [ -f /etc/systemd/system/cidrella-anomaly.service ]; then
    systemctl enable cidrella-anomaly 2>/dev/null || true
    systemctl start cidrella-anomaly 2>/dev/null || true
  fi
"
sleep 2

# Verify
CIDRELLA_STATUS=$(ssh "$SSH_TARGET" "systemctl is-active cidrella 2>/dev/null || echo failed")
DNSMASQ_STATUS=$(ssh "$SSH_TARGET" "systemctl is-active cidrella-dnsmasq 2>/dev/null || echo failed")
ANOMALY_STATUS=$(ssh "$SSH_TARGET" "systemctl is-active cidrella-anomaly 2>/dev/null || echo failed")

if [ "$CIDRELLA_STATUS" = "active" ] && [ "$DNSMASQ_STATUS" = "active" ]; then
  ok "Core services running."
else
  [ "$CIDRELLA_STATUS" != "active" ] && warn "cidrella: ${CIDRELLA_STATUS}"
  [ "$DNSMASQ_STATUS" != "active" ] && warn "cidrella-dnsmasq: ${DNSMASQ_STATUS}"
  warn "Check logs: ssh ${SSH_TARGET} journalctl -u cidrella -n 30"
fi

if [ "$ANOMALY_STATUS" = "active" ]; then
  ok "Anomaly detection service running."
else
  warn "cidrella-anomaly: ${ANOMALY_STATUS}"
fi

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════

VERSION=$(ssh "$SSH_TARGET" "node -e \"console.log(require('${INSTALL_DIR}/package.json').version)\"" 2>/dev/null || echo "unknown")

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Deployed CIDRella v${VERSION} to ${LXC_HOST}${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "  cidrella:         ${CIDRELLA_STATUS}"
echo -e "  cidrella-dnsmasq: ${DNSMASQ_STATUS}"
echo -e "  cidrella-anomaly: ${ANOMALY_STATUS}"
echo ""
