#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# CIDRella LXC Dev Deployer
# Syncs local dev tree to the LXC host, builds, and restarts.
#
# Usage:
#   ./scripts/deploy-lxc.sh              # full deploy
#   ./scripts/deploy-lxc.sh --skip-build # skip client build (server-only changes)
#   ./scripts/deploy-lxc.sh --host cidrella-test.example.com  # override target host
#   ./scripts/deploy-lxc.sh --bootstrap-version 0.4.18  # release to install on a bare LXC
#   ./scripts/deploy-lxc.sh --no-bootstrap  # fail instead of installing on a bare LXC
#
# A bare LXC (no cidrella user, bundled Node runtime or systemd units) is
# bootstrapped first by running this tree's scripts/install.sh on it, which
# installs a published release and everything it depends on. The dev tree is
# then synced over that install as usual. The installer is interactive, so a
# bootstrap needs a terminal.
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LXC_HOST="testerella"
LXC_USER="root"
INSTALL_DIR="/opt/cidrella"
SKIP_BUILD=false
BOOTSTRAP=true
BOOTSTRAP_VERSION=""

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
    --bootstrap-version) BOOTSTRAP_VERSION="$2"; shift 2 ;;
    --no-bootstrap) BOOTSTRAP=false; shift ;;
    *) err "Unknown argument: $1" ;;
  esac
done

SSH_TARGET="${LXC_USER}@${LXC_HOST}"

echo -e "\n${BOLD}═══ CIDRella LXC Deploy ═══${NC}\n"

# ═══════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════

info "Target: ${SSH_TARGET}:${INSTALL_DIR}"

# Resolve the target once, up front, and connect by address from then on.
# Every ssh and rsync below used to look the name up again, and a lookup that
# fails now and then (a single-label name like "testerella" from WSL, which
# goes through Windows name resolution) failed the deploy at a random step:
# "ssh: Could not resolve hostname". One lookup, retried, replaces dozens.
# HostKeyAlias keeps the host key checked under the name it was recorded as,
# and `ssh -G` applies ~/.ssh/config, so a HostName or HostKeyAlias set there
# wins.
SSH_CONFIG=$(ssh -G "$SSH_TARGET" 2>/dev/null || true)
SSH_HOSTNAME=$(awk '$1 == "hostname" { print $2; exit }' <<<"$SSH_CONFIG")
SSH_KEY_ALIAS=$(awk '$1 == "hostkeyalias" { print $2; exit }' <<<"$SSH_CONFIG")
SSH_HOSTNAME=${SSH_HOSTNAME:-$LXC_HOST}
if [[ $SSH_HOSTNAME =~ ^[0-9.]+$ || $SSH_HOSTNAME == *:* ]]; then
  TARGET_ADDR=$SSH_HOSTNAME
elif command -v getent >/dev/null 2>&1; then
  TARGET_ADDR=""
  # getent exits 2 for a name it cannot find; under pipefail that must not
  # end the script before the retries and the message below.
  for attempt in 1 2 3 4 5; do
    TARGET_ADDR=$({ getent ahostsv4 "$SSH_HOSTNAME" || getent ahosts "$SSH_HOSTNAME" || true; } \
      2>/dev/null | awk 'NR == 1 { print $1 }')
    if [ -n "$TARGET_ADDR" ]; then break; fi
    if [ "$attempt" -lt 5 ]; then sleep 1; fi
  done
else
  TARGET_ADDR=""
fi
SSH_OPTS=()
if [ -n "$TARGET_ADDR" ] && [ "$TARGET_ADDR" != "$SSH_HOSTNAME" ]; then
  SSH_OPTS=(-o "HostName=${TARGET_ADDR}" -o "HostKeyAlias=${SSH_KEY_ALIAS:-$SSH_HOSTNAME}")
  info "Resolved ${SSH_HOSTNAME} to ${TARGET_ADDR}; connecting by address from here on."
elif [ -z "$TARGET_ADDR" ] && command -v getent >/dev/null 2>&1; then
  err "Could not resolve ${SSH_HOSTNAME} after 5 tries. Pass --host <address>, or check name resolution here."
elif [ -z "$TARGET_ADDR" ]; then
  warn "No getent here to resolve ${SSH_HOSTNAME} once; every step will look it up by name."
fi
# Every ssh below, and rsync's remote shell, goes to that address.
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh ${SSH_OPTS[*]}"

# A deploy that dies after stopping the services would leave the LXC with
# CIDRella down until someone starts it by hand. Start them again on any
# failed exit.
SERVICES_STOPPED=false
restart_services_on_failure() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$SERVICES_STOPPED" = true ]; then
    warn "Deploy failed with the services stopped; starting them again on ${LXC_HOST}."
    ssh "$SSH_TARGET" "systemctl start cidrella-dnsmasq cidrella cidrella-anomaly 2>/dev/null || true" ||
      warn "Could not reach ${LXC_HOST} to start them: ssh ${SSH_TARGET} systemctl start cidrella-dnsmasq cidrella"
  fi
}
trap restart_services_on_failure EXIT

# Verify SSH connectivity. Automatically record a new test host, but keep
# rejecting changed keys so a rebuilt or impersonated target is never trusted
# silently. Leave stderr visible so SSH explains any key or config problem.
if ! ssh \
  -o ConnectTimeout=5 \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  "$SSH_TARGET" true; then
  err "Cannot connect to ${SSH_TARGET}. Check SSH config and keys."
fi
ok "SSH connection verified."

# What an existing install provides and every step below relies on: the
# service user, the bundled Node runtime (npm), the systemd units and rsync.
# A bare LXC has none of them.
MISSING=$(ssh "$SSH_TARGET" "
  id cidrella >/dev/null 2>&1 || echo user
  [ -x ${INSTALL_DIR}/runtime/node/bin/node ] || echo runtime
  [ -f /etc/systemd/system/cidrella.service ] || echo units
  command -v rsync >/dev/null 2>&1 || echo rsync
" | xargs)

if [ -n "$MISSING" ] && [ "$MISSING" != "rsync" ]; then
  warn "No CIDRella install on ${LXC_HOST} (missing: ${MISSING})."
  if [ "$BOOTSTRAP" = false ]; then
    err "Install CIDRella there first (scripts/install.sh), or run without --no-bootstrap."
  fi
  [ -t 0 ] || err "Bootstrapping runs the interactive installer; run this from a terminal."
  info "Bootstrapping with scripts/install.sh${BOOTSTRAP_VERSION:+ --version ${BOOTSTRAP_VERSION}}..."
  # Copied over the SSH session itself: a bare LXC may lack SFTP for scp.
  ssh "$SSH_TARGET" "cat > /tmp/cidrella-install.sh" < "$PROJECT_DIR/scripts/install.sh"
  # -t: the installer asks how to handle dnsmasq and systemd-resolved.
  ssh -t "$SSH_TARGET" \
    "bash /tmp/cidrella-install.sh ${BOOTSTRAP_VERSION:+--version ${BOOTSTRAP_VERSION}}; status=\$?; rm -f /tmp/cidrella-install.sh; exit \$status" \
    || err "The installer failed on ${LXC_HOST}; see its output above."
  ssh "$SSH_TARGET" "id cidrella >/dev/null 2>&1 && [ -x ${INSTALL_DIR}/runtime/node/bin/node ] && command -v rsync >/dev/null" \
    || err "The installer finished but ${LXC_HOST} still lacks the cidrella user, runtime or rsync."
  ok "Base install complete; deploying the dev tree over it."
elif [ "$MISSING" = "rsync" ]; then
  info "Installing rsync on the LXC..."
  ssh "$SSH_TARGET" "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq rsync >/dev/null" \
    || err "Could not install rsync on ${LXC_HOST}."
  ok "rsync installed."
fi

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
SERVICES_STOPPED=true
ssh "$SSH_TARGET" "systemctl stop cidrella-anomaly cidrella cidrella-dnsmasq 2>/dev/null || true"
ok "Services stopped."

# ═══════════════════════════════════════════════════════════
# SYNC FILES
# ═══════════════════════════════════════════════════════════

info "Syncing files to LXC..."

# Server source
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.pyo' \
  "$PROJECT_DIR/server/" "${SSH_TARGET}:${INSTALL_DIR}/server/"

# Client source, manifest, and built output. Preserve remote node_modules so
# local deploys do not force a client dependency reinstall.
rsync -az --delete \
  --exclude='node_modules' \
  "$PROJECT_DIR/client/" "${SSH_TARGET}:${INSTALL_DIR}/client/"

# dnsmasq config templates
rsync -az --delete \
  "$PROJECT_DIR/dnsmasq/" "${SSH_TARGET}:${INSTALL_DIR}/dnsmasq/"

# Scripts
rsync -az --delete \
  "$PROJECT_DIR/scripts/" "${SSH_TARGET}:${INSTALL_DIR}/scripts/"

# Root files used by the deployed app and maintenance commands.
rsync -az "$PROJECT_DIR/package.json" "${SSH_TARGET}:${INSTALL_DIR}/package.json"
rsync -az "$PROJECT_DIR/update.sh" "${SSH_TARGET}:${INSTALL_DIR}/update.sh"

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
  cd ${INSTALL_DIR}/server && PATH=${INSTALL_DIR}/runtime/node/bin:\$PATH npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
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

info "Fixing code permissions..."
ssh "$SSH_TARGET" "chown -R cidrella:cidrella ${INSTALL_DIR}"
ok "Permissions set."

# Native/LXC systemd deployments use cidrella.service AmbientCapabilities.
# Remove stale Node file caps; file-cap exec clears ambient capabilities and
# prevents child arping probes from inheriting CAP_NET_RAW.
ssh "$SSH_TARGET" "if [ -x ${INSTALL_DIR}/runtime/node/bin/node ]; then setcap -r ${INSTALL_DIR}/runtime/node/bin/node 2>/dev/null || true; fi"

ssh "$SSH_TARGET" "
  if [ -f ${INSTALL_DIR}/scripts/lib/dnsmasq-perms.sh ]; then
    . ${INSTALL_DIR}/scripts/lib/dnsmasq-perms.sh
    repair_dnsmasq_log_permissions /var/lib/cidrella
  fi
"

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

# Update stable command wrappers. These resolve through /opt/cidrella and do
# not point at a concrete A/B slot.
ssh "$SSH_TARGET" "
  if [ -f ${INSTALL_DIR}/update.sh ]; then
    chmod 0755 ${INSTALL_DIR}/update.sh
    ln -sf ${INSTALL_DIR}/update.sh /usr/local/bin/cidrella-update
  fi
  if [ -f ${INSTALL_DIR}/scripts/cidrella-node ]; then
    install -m 0755 ${INSTALL_DIR}/scripts/cidrella-node /usr/local/bin/cidrella-node
  fi
  if [ -f ${INSTALL_DIR}/scripts/cidrella-npm ]; then
    install -m 0755 ${INSTALL_DIR}/scripts/cidrella-npm /usr/local/bin/cidrella-npm
  fi
  if [ -f ${INSTALL_DIR}/scripts/cidrella-dnsmasq-hup ]; then
    install -m 0755 -o root -g root ${INSTALL_DIR}/scripts/cidrella-dnsmasq-hup /usr/local/bin/cidrella-dnsmasq-hup
  fi
  if [ -f ${INSTALL_DIR}/scripts/cidrella-reset-password ]; then
    install -m 0700 -o root -g root ${INSTALL_DIR}/scripts/cidrella-reset-password /usr/local/bin/cidrella-reset-password
  fi
  if [ -f ${INSTALL_DIR}/scripts/cidrella-reset-web-ports ]; then
    install -m 0700 -o root -g root ${INSTALL_DIR}/scripts/cidrella-reset-web-ports /usr/local/bin/cidrella-reset-web-ports
  fi
"

# ═══════════════════════════════════════════════════════════
# START SERVICES
# ═══════════════════════════════════════════════════════════

info "Starting services..."
ssh "$SSH_TARGET" "systemctl start cidrella-dnsmasq cidrella"
SERVICES_STOPPED=false

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

VERSION=$(ssh "$SSH_TARGET" "PATH=${INSTALL_DIR}/runtime/node/bin:\$PATH node -e \"console.log(require('${INSTALL_DIR}/package.json').version)\"" 2>/dev/null || echo "unknown")

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Deployed CIDRella v${VERSION} to ${LXC_HOST}${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "  cidrella:         ${CIDRELLA_STATUS}"
echo -e "  cidrella-dnsmasq: ${DNSMASQ_STATUS}"
echo -e "  cidrella-anomaly: ${ANOMALY_STATUS}"
echo ""
