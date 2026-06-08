#!/bin/bash
set -euo pipefail

# Anchor CWD to / so we never depend on the invoker's working directory.
# See the note in update.sh — same reasoning: if the caller is cd'd into a
# directory this script ends up removing (slot wipe, data dir cleanup, etc),
# child processes like rsync will fail on getcwd() at startup. Immunizing
# here is a one-line fix.
cd / 2>/dev/null || true

# ═══════════════════════════════════════════════════════════
# CIDRella Installer
# Interactive installer for Debian/Ubuntu (bare-metal or LXC)
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
#   # or with a specific version:
#   sudo bash install.sh --version 0.1.0
# ═══════════════════════════════════════════════════════════

GITHUB_REPO="fatcat/cidrella"
INSTALL_LINK="/opt/cidrella"
INSTALL_DIR="/opt/cidrella-a"   # first slot in the A/B layout; INSTALL_LINK -> here
DATA_DIR="/var/lib/cidrella"
SERVICE_USER="cidrella"
REQUESTED_VERSION=""
MINISIGN_PUBKEY="RWT6J/NrAcT9LsHz9fQG8sAbcsfp58uRxiYx3YbZUpm28lFwjaVi4wQe"
BREAKGLASS_PUBKEY="RWRO6YFjR0VEbOr73Kjk9WNdUFgaVrZ/de+/S3bGYaroJaMLrxN7nLQK"
FORCE_INSTALL=false
NODE_MAJOR=22
BUILD_ARCH="linux-x64"
WEB_HTTPS_PORT="8443"
WEB_HTTP_PORT="8080"

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# Minimal inline JSONL event emitter — this script runs via curl|bash
# before any tarball exists on disk, so we can't source scripts/lib/log.sh
# until after extraction. This inline version produces the same JSONL
# format as lib/log.sh so the install and update event streams are
# homogeneous when tailed together.
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
  # Auto-create the log dir so the very first event of a fresh install isn't
  # silently dropped. mkdir -p is idempotent; 2>/dev/null swallows the "exists"
  # noise; || true prevents a failure here from killing install.sh under set -e.
  mkdir -p "$dir" 2>/dev/null || true
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    printf '%s\n' "$line" >> "$dir/events.jsonl" 2>/dev/null || true
  fi
}

ask_yn() {
  local prompt="$1"
  local default="${2:-n}"
  local yn
  while true; do
    if [ "$default" = "y" ]; then
      read -rp "$(echo -e "${BOLD}$prompt [Y/n]:${NC} ")" yn
      yn="${yn:-y}"
    else
      read -rp "$(echo -e "${BOLD}$prompt [y/N]:${NC} ")" yn
      yn="${yn:-n}"
    fi
    case "$yn" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

ask_choice() {
  local prompt="$1"
  shift
  local options=("$@")
  local i=1
  echo -e "\n${BOLD}$prompt${NC}"
  for opt in "${options[@]}"; do
    echo "  $i) $opt"
    ((i++))
  done
  local choice
  while true; do
    read -rp "$(echo -e "${BOLD}Choose [1-${#options[@]}]:${NC} ")" choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
      return "$choice"
    fi
    echo "Please enter a number between 1 and ${#options[@]}."
  done
}

# ─── Parse arguments ──────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --force) FORCE_INSTALL=true; shift ;;
    --update)
      echo "For updates, use: cidrella-update"
      echo "Or: /opt/cidrella/update.sh"
      exit 0
      ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════
# PREFLIGHT CHECKS
# ═══════════════════════════════════════════════════════════

echo -e "\n${BOLD}═══ CIDRella Installer ═══${NC}\n"
emit_event install start "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" "pid=$$"

# Must be root
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
  emit_event install fail reason=not-root
  exit 1
fi

# Check OS
if [ ! -f /etc/os-release ]; then
  err "Cannot detect OS. This installer requires Debian or Ubuntu."
  exit 1
fi

. /etc/os-release
if [[ "$ID" != "debian" && "$ID" != "ubuntu" && "$ID_LIKE" != *"debian"* ]]; then
  warn "Detected OS: $PRETTY_NAME"
  warn "This installer is designed for Debian/Ubuntu."
  if ! ask_yn "Continue anyway?"; then
    exit 1
  fi
else
  info "Detected OS: $PRETTY_NAME"
fi

# Check architecture
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$ARCH" in
  amd64|x86_64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    warn "Unsupported architecture: $ARCH"
    if ! ask_yn "Continue anyway?"; then
      exit 1
    fi
    ;;
esac
info "Architecture: $ARCH"

# Check for existing installation (via the symlink path users know)
if [ -e "$INSTALL_LINK" ]; then
  if [ ! -f "$INSTALL_LINK/package.json" ]; then
    warn "Partial installation detected at $INSTALL_LINK. Continuing install..."
  elif [ "$FORCE_INSTALL" = true ]; then
    warn "Overwriting existing installation at $INSTALL_LINK (--force)."
  else
    warn "CIDRella is already installed at $INSTALL_LINK."
    if [ -f "$INSTALL_LINK/update.sh" ]; then
      info "To update, run: cidrella-update"
    fi
    if ! ask_yn "Reinstall / overwrite?"; then
      exit 0
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════
# SYSTEMD-RESOLVED DETECTION
# ═══════════════════════════════════════════════════════════

if ss -tlnp 2>/dev/null | grep -q ':53 '; then
  RESOLVER_PID=$(ss -tlnp 2>/dev/null | grep ':53 ' | head -1 | grep -oP 'pid=\K[0-9]+' || true)
  RESOLVER_NAME=""
  if [ -n "$RESOLVER_PID" ]; then
    RESOLVER_NAME=$(ps -p "$RESOLVER_PID" -o comm= 2>/dev/null || true)
  fi

  if [ "$RESOLVER_NAME" = "systemd-resolve" ] || systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    echo ""
    warn "systemd-resolved is listening on port 53."
    info "CIDRella's DNS server (dnsmasq) needs port 53."
    info "systemd-resolved's stub listener must be disabled for CIDRella to work."
    echo ""
    info "This will:"
    info "  1. Set DNSStubListener=no in /etc/systemd/resolved.conf"
    info "  2. Replace /etc/resolv.conf with a direct nameserver entry"
    info "  3. Restart systemd-resolved"
    echo ""

    if ask_yn "Disable systemd-resolved stub listener?"; then
      # Backup
      cp /etc/systemd/resolved.conf /etc/systemd/resolved.conf.bak 2>/dev/null || true

      # Disable stub listener
      if grep -q '^\s*#\?\s*DNSStubListener' /etc/systemd/resolved.conf; then
        sed -i 's/^\s*#\?\s*DNSStubListener=.*/DNSStubListener=no/' /etc/systemd/resolved.conf
      else
        echo "DNSStubListener=no" >> /etc/systemd/resolved.conf
      fi

      # Fix resolv.conf — point directly at upstream (will be replaced by dnsmasq later)
      rm -f /etc/resolv.conf
      echo "nameserver 8.8.8.8" > /etc/resolv.conf
      echo "nameserver 9.9.9.9" >> /etc/resolv.conf

      systemctl restart systemd-resolved
      ok "systemd-resolved stub listener disabled."
    else
      warn "Skipping. DNS may not work if port 53 is still in use."
      warn "You will need to resolve this manually."
    fi
  else
    warn "Something is already listening on port 53 (process: ${RESOLVER_NAME:-unknown})."
    warn "CIDRella's dnsmasq needs port 53. You may need to stop the conflicting service."
    if ! ask_yn "Continue anyway?"; then
      exit 1
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════
# NTP — system clock sync (required for DNSSEC validation)
# ═══════════════════════════════════════════════════════════
#
# DNSSEC signature validation checks each signature's NotBefore/NotAfter
# window, so a host with a wrong clock SERVFAILs signed lookups. Ensure an NTP
# client is active. The app can also re-enable NTP at runtime via a polkit
# grant (see 49-cidrella.rules), but enabling it here makes a fresh install
# correct from first boot. Idempotent: skips when NTP is already on.
if command -v timedatectl >/dev/null 2>&1; then
  if timedatectl show -p NTP --value 2>/dev/null | grep -qx yes; then
    ok "NTP time sync already enabled."
  else
    info "Enabling NTP time synchronization (required for DNSSEC)..."
    # Ensure a client exists: prefer an already-installed timesyncd/chrony/ntp,
    # otherwise install systemd-timesyncd (smallest footprint).
    if ! systemctl list-unit-files 2>/dev/null | grep -qE '^(systemd-timesyncd|chrony|chronyd|ntp)\.service'; then
      apt-get install -y -qq systemd-timesyncd >/dev/null 2>&1 || \
        warn "Could not install systemd-timesyncd — enable an NTP client manually for DNSSEC."
    fi
    if timedatectl set-ntp true 2>/dev/null; then
      ok "NTP time sync enabled."
    else
      warn "Failed to enable NTP. DNSSEC validation may fail on clock skew until corrected."
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════
# NODE.JS — bundled runtime
# ═══════════════════════════════════════════════════════════
#
# Starting in v0.4.7 CIDRella ships its own Node runtime inside the release
# tarball at $SLOT/runtime/node/bin/node. The cidrella-node wrapper resolves
# to that path before falling through to the system binary, and the systemd
# unit's ExecStart points at /usr/local/bin/cidrella-node — so we don't need
# a system Node at all. The previous NodeSource install block was removed.
#
# If the user already has a system Node installed (from an earlier install
# or their own apt install), we leave it alone — harmless, just unused.
if command -v node >/dev/null 2>&1; then
  info "System Node.js $(node -v) present (will be unused — runtime ships bundled)"
else
  info "No system Node.js — using bundled runtime from release tarball"
fi

# ═══════════════════════════════════════════════════════════
# SYSTEM PACKAGES
# ═══════════════════════════════════════════════════════════
#
# Dropped from this list in v0.4.7: nmap (never called by the app — was in
# the prior apt list unused), nodejs (bundled now). build-essential and
# python3-setuptools are kept because some users may still want to `npm
# rebuild` manually. arping and iputils-ping are kept because the scanner
# uses arping first and system ping as the ICMP fallback.
# The python packages are for the anomaly detection daemon.

info "Installing system dependencies..."
# polkit (a.k.a. policykit-1 on older Debian/Ubuntu, polkitd on newer) is a
# HARD dependency as of v0.4.11. The cidrella server triggers the in-app
# updater and dnsmasq reload via polkit-gated systemctl calls — without a
# working polkit daemon and JS rules engine, those grants never apply and
# the UI updater silently fails the same way the v0.4.8/v0.4.9 sudo path
# did. Try the modern package name first, fall back to the legacy name.
apt-get install -y -qq build-essential arping iputils-ping openssl curl dnsutils rsync sudo minisign libcap2-bin python3 python3-setuptools python3-sklearn python3-numpy python3-joblib >/dev/null 2>&1
if ! command -v openssl >/dev/null 2>&1; then
  err "openssl is required for TLS certificate generation, CSR generation, and certificate validation."
  err "Install it manually with: apt-get install openssl"
  exit 1
fi
if ! apt-get install -y -qq polkitd >/dev/null 2>&1; then
  if ! apt-get install -y -qq policykit-1 >/dev/null 2>&1; then
    err "Failed to install polkit (tried polkitd and policykit-1)."
    err "polkit is required as of v0.4.11 to authorize the in-app updater"
    err "and dnsmasq reload via polkit-gated systemctl. Install manually:"
    err "    apt-get install polkitd    (Debian 12+ / Ubuntu 24.04+)"
    err "    apt-get install policykit-1  (older releases)"
    emit_event polkit fail reason=apt-install-failed
    exit 1
  fi
fi
ok "System packages installed."

# Verify polkit is actually running and the JS rules engine works. The
# .rules file format requires polkit ≥0.106 with the JS backend. On some
# minimal Ubuntu 22.04 images, `policykit-1` is installed but the JS engine
# is absent or polkitd isn't running, in which case our 49-cidrella.rules
# file is silently ignored and the cidrella user gets PermissionDenied on
# every systemctl call. Probe with `pkaction --version` and confirm at
# least one of polkit/polkitd is active.
if ! command -v pkaction >/dev/null 2>&1; then
  err "polkit installed but pkaction missing. Cannot verify JS rules engine."
  emit_event polkit fail reason=pkaction-missing
  exit 1
fi
POLKIT_VER=$(pkaction --version 2>/dev/null | awk '{print $NF}' | head -1)
ok "polkit version: ${POLKIT_VER:-unknown}"
if ! systemctl is-active --quiet polkit 2>/dev/null && ! systemctl is-active --quiet polkitd 2>/dev/null; then
  warn "polkit daemon is not currently active. Starting it..."
  systemctl start polkit 2>/dev/null || systemctl start polkitd 2>/dev/null || {
    err "Failed to start polkit. The in-app updater will not work."
    emit_event polkit fail reason=daemon-start-failed
    exit 1
  }
fi
emit_event polkit pass "version=${POLKIT_VER:-unknown}"

# ═══════════════════════════════════════════════════════════
# DNSMASQ
# ═══════════════════════════════════════════════════════════

DNSMASQ_MODE="own"  # own | include | skip

if dpkg -l dnsmasq 2>/dev/null | grep -q '^ii'; then
  # dnsmasq is installed
  if systemctl is-active --quiet dnsmasq 2>/dev/null; then
    warn "dnsmasq is already installed and running."
    ask_choice "How should CIDRella handle dnsmasq?" \
      "Replace dnsmasq config (CIDRella takes full control)" \
      "Include CIDRella config (add conf-dir to existing config)" \
      "Skip (I will configure dnsmasq manually)"
    choice=$?
    case "$choice" in
      1) DNSMASQ_MODE="own" ;;
      2) DNSMASQ_MODE="include" ;;
      3) DNSMASQ_MODE="skip" ;;
    esac
  else
    info "dnsmasq is installed but not running."
    if ask_yn "Let CIDRella manage dnsmasq?" "y"; then
      DNSMASQ_MODE="own"
    else
      DNSMASQ_MODE="skip"
    fi
  fi
else
  info "Installing dnsmasq..."
  apt-get install -y -qq dnsmasq >/dev/null 2>&1
  # Stop the default system service — CIDRella uses its own unit
  systemctl stop dnsmasq 2>/dev/null || true
  systemctl disable dnsmasq 2>/dev/null || true
  DNSMASQ_MODE="own"
  ok "dnsmasq installed."
fi

# ═══════════════════════════════════════════════════════════
# CREATE USER & DIRECTORIES
# ═══════════════════════════════════════════════════════════

info "Setting up user and directories..."

# Create system user
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Created system user: $SERVICE_USER"
else
  ok "User $SERVICE_USER already exists."
fi

# Create data directories. `snapshots/` is explicitly listed — update.sh
# later writes pre-update/ under it as root, and the running cidrella
# service writes pre-restore/ under it at restore time. Pre-seeding the
# parent dir with cidrella ownership avoids an EACCES in the restore path
# the first time a restore runs on a v0.4.14 host that never saw a snapshot.
mkdir -p "$DATA_DIR"/{certs,backups,dnsmasq/{hosts.d,dhcp-hosts.d,conf.d},blocklists,geoip,anomaly/models,snapshots}
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
ok "Data directory: $DATA_DIR"

# ═══════════════════════════════════════════════════════════
# DOWNLOAD RELEASE
# ═══════════════════════════════════════════════════════════

info "Downloading CIDRella..."

if [ -n "$REQUESTED_VERSION" ]; then
  TAG="v${REQUESTED_VERSION}"
  RELEASE_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
else
  RELEASE_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
fi

# Fetch release info
RELEASE_JSON=$(curl -fsSL "$RELEASE_URL" 2>/dev/null || true)
if [ -z "$RELEASE_JSON" ]; then
  err "Failed to fetch release info from GitHub."
  err "URL: $RELEASE_URL"
  exit 1
fi

TAG_NAME=$(echo "$RELEASE_JSON" | grep -oP '"tag_name"\s*:\s*"\K[^"]+' | head -1)
VERSION="${TAG_NAME#v}"

# Find tarball asset
TARBALL_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.tar\.gz' | head -1)
if [ -z "$TARBALL_URL" ]; then
  # Fallback to source tarball
  TARBALL_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/cidrella-${TAG_NAME}.tar.gz"
fi

info "Version: $VERSION"
info "Downloading: $TARBALL_URL"

# Download and extract
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

curl -fsSL "$TARBALL_URL" -o "$TMPDIR/cidrella.tar.gz"

# Download and verify signature
MINISIG_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url"\s*:\s*"\K[^"]*\.minisig"' | sed 's/"$//' | head -1)
if [ -z "$MINISIG_URL" ]; then
  MINISIG_URL="${TARBALL_URL}.minisig"
fi

if command -v minisign &>/dev/null; then
  curl -fsSL "$MINISIG_URL" -o "$TMPDIR/cidrella.tar.gz.minisig" || {
    err "Failed to download signature file. Aborting."
    exit 1
  }
  PUBKEY_TMP="$TMPDIR/cidrella.pub"
  printf 'untrusted comment: minisign public key\n%s\n' "$MINISIGN_PUBKEY" > "$PUBKEY_TMP"
  if minisign -Vm "$TMPDIR/cidrella.tar.gz" -p "$PUBKEY_TMP" >/dev/null; then
    ok "Signature verified."
    emit_event verify pass
  else
    err "Signature verification failed! The download may be corrupted or tampered with."
    emit_event verify fail reason=bad-signature
    exit 1
  fi
else
  warn "minisign not installed — skipping signature verification."
  emit_event verify skip reason=no-minisign
fi

# ═══════════════════════════════════════════════════════════
# EXTRACT TO A/B LAYOUT
# ═══════════════════════════════════════════════════════════
# /opt/cidrella-a/   (slot A — fresh install goes here)
# /opt/cidrella-b/   (slot B — reserved, populated by first update)
# /opt/cidrella      (symlink -> /opt/cidrella-a)

# If /opt/cidrella exists as a plain directory (legacy install), remove it
# so we can replace with the symlink.
if [ -d "$INSTALL_LINK" ] && [ ! -L "$INSTALL_LINK" ]; then
  # Move the legacy install aside; the rest of this script will replace it.
  rm -rf "$INSTALL_LINK"
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR/cidrella.tar.gz" -C "$TMPDIR"

# Find the extracted directory (might be nested)
EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "cidrella*" | head -1)
if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "$TMPDIR" ]; then
  EXTRACTED="$TMPDIR"
fi

# Copy extracted files into slot A
rsync -a "$EXTRACTED/" "$INSTALL_DIR/"
ok "Extracted to $INSTALL_DIR"
emit_event extract pass "target_slot=$INSTALL_DIR" "version=$VERSION"

# Create the /opt/cidrella symlink -> slot A
ln -sfn "$INSTALL_DIR" "$INSTALL_LINK"
ok "Symlink: $INSTALL_LINK -> $INSTALL_DIR"

# ─── Source shared library helpers (now that the slot is populated) ──
# From here on we can use lib/systemd-install.sh. lib/log.sh's emit_event
# will redefine our inline stub — since both produce the same JSONL line
# format, the event stream stays homogeneous across the transition.
if [ -f "$INSTALL_DIR/scripts/lib/systemd-install.sh" ]; then
  # shellcheck source=scripts/lib/systemd-install.sh
  source "$INSTALL_DIR/scripts/lib/systemd-install.sh"
fi
if [ -f "$INSTALL_DIR/scripts/lib/log.sh" ]; then
  # shellcheck source=scripts/lib/log.sh
  source "$INSTALL_DIR/scripts/lib/log.sh"
fi

# ═══════════════════════════════════════════════════════════
# INSTALL NODE DEPENDENCIES (only if not bundled in tarball)
# ═══════════════════════════════════════════════════════════

if [ -d "$INSTALL_DIR/server/node_modules/express" ]; then
  ok "Bundled node_modules present — skipping npm install"
else
  info "Installing Node.js dependencies (this may take a moment)..."
  cd "$INSTALL_DIR/server"
  if [ -x "$INSTALL_DIR/runtime/node/bin/npm" ]; then
    PATH="$INSTALL_DIR/runtime/node/bin:$PATH" "$INSTALL_DIR/runtime/node/bin/npm" install --omit=dev --silent 2>&1 | tail -5
  elif command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --silent 2>&1 | tail -5
  else
    err "Bundled node_modules are missing and no npm binary is available."
    err "Expected bundled npm at $INSTALL_DIR/runtime/node/bin/npm."
    emit_event install fail reason=no-npm-for-dependency-recovery
    exit 1
  fi
  ok "Dependencies installed."
fi

# ═══════════════════════════════════════════════════════════
# CONFIGURE DNSMASQ
# ═══════════════════════════════════════════════════════════

DNSMASQ_CONF="$DATA_DIR/dnsmasq/dnsmasq.conf"

if [ "$DNSMASQ_MODE" = "own" ]; then
  if [ ! -f "$DNSMASQ_CONF" ] || ask_yn "Overwrite existing dnsmasq config?"; then
    cp "$INSTALL_DIR/dnsmasq/dnsmasq.conf.default" "$DNSMASQ_CONF"
    # Replace /data/ paths with native data dir
    sed -i "s|/data/|${DATA_DIR}/|g" "$DNSMASQ_CONF"
    ok "dnsmasq config written to $DNSMASQ_CONF"
  fi

  # Ensure log and pid files exist
  touch "$DATA_DIR/dnsmasq/dnsmasq.log"
  touch "$DATA_DIR/dnsmasq/dnsmasq.pid"
  if [ -f "$INSTALL_DIR/scripts/lib/dnsmasq-perms.sh" ]; then
    # shellcheck source=scripts/lib/dnsmasq-perms.sh
    source "$INSTALL_DIR/scripts/lib/dnsmasq-perms.sh"
    repair_dnsmasq_log_permissions "$DATA_DIR"
  fi

  # Disable system dnsmasq service if it exists
  systemctl stop dnsmasq 2>/dev/null || true
  systemctl disable dnsmasq 2>/dev/null || true

elif [ "$DNSMASQ_MODE" = "include" ]; then
  # Add CIDRella include directives to system dnsmasq config
  SYSTEM_CONF="/etc/dnsmasq.conf"
  if [ -f "$SYSTEM_CONF" ]; then
    if ! grep -q "$DATA_DIR/dnsmasq/conf.d" "$SYSTEM_CONF"; then
      echo "" >> "$SYSTEM_CONF"
      echo "# CIDRella managed configuration" >> "$SYSTEM_CONF"
      echo "conf-dir=${DATA_DIR}/dnsmasq/conf.d/,*.conf" >> "$SYSTEM_CONF"
      echo "hostsdir=${DATA_DIR}/dnsmasq/hosts.d/" >> "$SYSTEM_CONF"
      echo "dhcp-hostsdir=${DATA_DIR}/dnsmasq/dhcp-hosts.d/" >> "$SYSTEM_CONF"
      ok "Added CIDRella includes to $SYSTEM_CONF"
      info "Note: CIDRella cannot manage listen-address or global dnsmasq settings in include mode."
    else
      ok "CIDRella includes already present in $SYSTEM_CONF"
    fi
  fi
fi

# Set data directory ownership
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ═══════════════════════════════════════════════════════════
# INSTALL SYSTEMD UNITS
# ═══════════════════════════════════════════════════════════

info "Installing systemd services..."

# Install cidrella-node wrapper first — v0.4.3+ systemd units reference it
# as ExecStart, so it must exist before daemon-reload runs.
if [ -f "$INSTALL_DIR/scripts/cidrella-node" ]; then
  install -m 0755 "$INSTALL_DIR/scripts/cidrella-node" /usr/local/bin/cidrella-node
  ok "Installed /usr/local/bin/cidrella-node wrapper"
fi

# Install cidrella-npm wrapper for admin/build commands that need npm from
# the active bundled runtime. It resolves through /opt/cidrella, not a
# concrete A/B slot, so slot switches do not leave stale PATH guidance behind.
if [ -f "$INSTALL_DIR/scripts/cidrella-npm" ]; then
  install -m 0755 "$INSTALL_DIR/scripts/cidrella-npm" /usr/local/bin/cidrella-npm
  ok "Installed /usr/local/bin/cidrella-npm wrapper"
fi

# Install cidrella-dnsmasq-hup wrapper (v0.4.6+). The wrapper replaces the
# previous overly-broad `kill -HUP [0-9]*` sudoers rule with a narrow, audited
# path that only signals dnsmasq. Sudoers only permits this exact binary.
if [ -f "$INSTALL_DIR/scripts/cidrella-dnsmasq-hup" ]; then
  install -m 0755 -o root -g root "$INSTALL_DIR/scripts/cidrella-dnsmasq-hup" /usr/local/bin/cidrella-dnsmasq-hup
  ok "Installed /usr/local/bin/cidrella-dnsmasq-hup wrapper"
fi

# Install cidrella-reset-password wrapper (v0.4.8+). Root-only (0700). Wraps
# server/src/reset-password.js so admins can recover from a forgotten admin
# password after a fresh install + legacy backup restore. Every reset writes
# an audit_log row and populates users.password_reset_by, so the legit owner
# sees a banner on next login if the reset was unauthorized.
if [ -f "$INSTALL_DIR/scripts/cidrella-reset-password" ]; then
  install -m 0700 -o root -g root "$INSTALL_DIR/scripts/cidrella-reset-password" /usr/local/bin/cidrella-reset-password
  ok "Installed /usr/local/bin/cidrella-reset-password wrapper"
fi

# Install cidrella-reset-web-ports wrapper (v0.4.15+). Root-only (0700).
# Clears DB web-port overrides and restarts cidrella so admins can recover
# from a port change that made the UI unreachable.
if [ -f "$INSTALL_DIR/scripts/cidrella-reset-web-ports" ]; then
  install -m 0700 -o root -g root "$INSTALL_DIR/scripts/cidrella-reset-web-ports" /usr/local/bin/cidrella-reset-web-ports
  ok "Installed /usr/local/bin/cidrella-reset-web-ports wrapper"
fi

# install_systemd_unit is sourced from scripts/lib/systemd-install.sh above;
# fall back to plain cp if sourcing failed (pre-v0.4.4 tarballs).
_install_unit() {
  local src="$1" dst="$2"
  if command -v install_systemd_unit >/dev/null 2>&1; then
    install_systemd_unit "$src" "$dst" >/dev/null && return 0
  fi
  cp "$src" "$dst"
}

_install_unit "$INSTALL_DIR/scripts/systemd/cidrella.service" /etc/systemd/system/cidrella.service
ok "Installed cidrella.service"
emit_event systemd pass unit=cidrella.service

# ═══════════════════════════════════════════════════════════
# WEB PORT PROBE (v0.4.15+)
#
# The unit ships with HTTPS_PORT=8443 HTTP_PORT=8080 as a safe fallback.
# On a FRESH install we prefer 443/80 so the user browses to
# `https://cidrella.local` without a port suffix. If either port is
# already bound (e.g. by nginx, another appliance), we leave the unit's
# default in place. Upgrades never run this block — update.sh explicitly
# skips unit reinstall when the existing unit is present, so any port
# override the user set previously is preserved.
# ═══════════════════════════════════════════════════════════

PORT_OVERRIDE_FILE="/etc/systemd/system/cidrella.service.d/port-override.conf"
if [ -f "$PORT_OVERRIDE_FILE" ]; then
  EXISTING_HTTPS_PORT=$(grep -E '^Environment=HTTPS_PORT=' "$PORT_OVERRIDE_FILE" 2>/dev/null | tail -1 | sed 's/^Environment=HTTPS_PORT=//' || true)
  EXISTING_HTTP_PORT=$(grep -E '^Environment=HTTP_PORT=' "$PORT_OVERRIDE_FILE" 2>/dev/null | tail -1 | sed 's/^Environment=HTTP_PORT=//' || true)
  WEB_HTTPS_PORT="${EXISTING_HTTPS_PORT:-$WEB_HTTPS_PORT}"
  WEB_HTTP_PORT="${EXISTING_HTTP_PORT:-$WEB_HTTP_PORT}"
fi
# If an override already exists, don't touch it — upgrade path.
if [ ! -f "$PORT_OVERRIDE_FILE" ]; then
  port_free() {
    # ss returns 0 whether or not it found anything; use grep to actually detect.
    ! ss -tln 2>/dev/null | awk '{print $4}' | grep -E "[:.]${1}\$" >/dev/null
  }
  if port_free 443 && port_free 80; then
    mkdir -p /etc/systemd/system/cidrella.service.d
    cat > "$PORT_OVERRIDE_FILE" <<'EOF'
# CIDRella web-server port override — written by install.sh at first install.
# Upgrades never touch this file. To revert to the default 8443/8080, delete
# this file and run `systemctl daemon-reload && systemctl restart cidrella`.
[Service]
Environment=HTTPS_PORT=443
Environment=HTTP_PORT=80
EOF
    chmod 644 "$PORT_OVERRIDE_FILE"
    WEB_HTTPS_PORT="443"
    WEB_HTTP_PORT="80"
    ok "Web ports: 443/80 (standard HTTPS/HTTP — both free)"
    emit_event systemd pass web_ports=443/80
  else
    info "Web ports 443 and/or 80 already in use — keeping defaults 8443/8080"
    emit_event systemd pass web_ports=8443/8080
  fi
fi

_install_unit "$INSTALL_DIR/scripts/systemd/cidrella-anomaly.service" /etc/systemd/system/cidrella-anomaly.service
ok "Installed cidrella-anomaly.service"
emit_event systemd pass unit=cidrella-anomaly.service

# v0.4.11+: templated update worker unit. The cidrella server starts an
# instance of this unit via polkit-gated systemctl when an in-app update is
# triggered. See scripts/polkit/49-cidrella.rules and the comment block at
# the top of the unit file for the full rationale.
_install_unit "$INSTALL_DIR/scripts/systemd/cidrella-update@.service" /etc/systemd/system/cidrella-update@.service
ok "Installed cidrella-update@.service"
emit_event systemd pass unit=cidrella-update@.service

if [ "$DNSMASQ_MODE" = "own" ]; then
  _install_unit "$INSTALL_DIR/scripts/systemd/cidrella-dnsmasq.service" /etc/systemd/system/cidrella-dnsmasq.service
  ok "Installed cidrella-dnsmasq.service"
  emit_event systemd pass unit=cidrella-dnsmasq.service
fi

# v0.4.15+: logrotate for dnsmasq.log. Prevents the unbounded growth that
# inflated every backup to >1 GB before the 2026-04-21 hardening work.
# Config uses copytruncate, so no restart or SIGUSR2 is needed.
if [ -d /etc/logrotate.d ]; then
  install -m 0644 -o root -g root \
    "$INSTALL_DIR/scripts/logrotate/cidrella-dnsmasq" \
    /etc/logrotate.d/cidrella-dnsmasq
  ok "Installed logrotate config (/etc/logrotate.d/cidrella-dnsmasq)"
fi

# v0.4.11+: polkit rule. Authorizes the cidrella service account to start
# cidrella-update@*.service instances and reload/restart cidrella-dnsmasq
# via D-Bus, replacing the sudo+setuid path that was broken by the v0.4.8
# NoNewPrivileges-implied hardening on cidrella.service.
mkdir -p /etc/polkit-1/rules.d
install -m 0644 -o root -g root \
  "$INSTALL_DIR/scripts/polkit/49-cidrella.rules" \
  /etc/polkit-1/rules.d/49-cidrella.rules
ok "Installed polkit rule (/etc/polkit-1/rules.d/49-cidrella.rules)"
# Polkit picks up new rules on the next D-Bus call to logind/systemd1.
# Modern polkitd uses inotify on the rules.d directory; older versions need
# an explicit reload. Try the reload but don't fail on it — the next D-Bus
# call will pick up the rule regardless.
systemctl reload polkit 2>/dev/null || systemctl reload polkitd 2>/dev/null || true

# Install sudoers. This file is intentionally empty on current releases; it
# overwrites stale sudo grants left by older CIDRella installs.
cp "$INSTALL_DIR/scripts/sudoers/cidrella" /etc/sudoers.d/cidrella
chmod 440 /etc/sudoers.d/cidrella
ok "Installed sudoers rules."

# Native systemd installs use AmbientCapabilities from cidrella.service.
# Do NOT set file capabilities on Node: executing a file-capability binary
# clears the ambient set, so child arping probes do not inherit CAP_NET_RAW.
# Remove stale caps from older installs/releases that used setcap.
BUNDLED_NODE_BIN="$INSTALL_DIR/runtime/node/bin/node"
if [ -x "$BUNDLED_NODE_BIN" ]; then
  setcap -r "$BUNDLED_NODE_BIN" 2>/dev/null || true
  ok "Using systemd ambient capabilities for active scans."
else
  warn "Bundled Node binary not found; active scans require cidrella.service AmbientCapabilities to be honored by the runtime."
fi

systemctl daemon-reload

# ═══════════════════════════════════════════════════════════
# CREATE UPDATE + ROLLBACK SYMLINKS
# ═══════════════════════════════════════════════════════════

if [ -f "$INSTALL_LINK/update.sh" ]; then
  # Point symlink through /opt/cidrella (follows active slot)
  ln -sf "$INSTALL_LINK/update.sh" /usr/local/bin/cidrella-update
  chmod +x "$INSTALL_LINK/update.sh"
  ok "Update command: cidrella-update"
fi

if [ -f "$INSTALL_LINK/scripts/rollback.sh" ]; then
  # Copy (not symlink) the rollback script so it survives if /opt/cidrella
  # gets corrupted — rollback must never depend on the installation it is
  # rolling back.
  cp "$INSTALL_LINK/scripts/rollback.sh" /usr/local/bin/cidrella-rollback
  chmod +x /usr/local/bin/cidrella-rollback
  ok "Rollback command: cidrella-rollback"
fi

# ═══════════════════════════════════════════════════════════
# START SERVICES
# ═══════════════════════════════════════════════════════════

info "Starting services..."

if [ "$DNSMASQ_MODE" = "own" ]; then
  systemctl enable cidrella-dnsmasq 2>/dev/null
  systemctl start cidrella-dnsmasq
  ok "cidrella-dnsmasq started."
elif [ "$DNSMASQ_MODE" = "include" ]; then
  systemctl restart dnsmasq 2>/dev/null || warn "Could not restart system dnsmasq."
fi

systemctl enable cidrella 2>/dev/null
systemctl start cidrella
ok "cidrella started."

systemctl enable cidrella-anomaly 2>/dev/null
systemctl start cidrella-anomaly
ok "cidrella-anomaly started."

# Wait briefly for startup
sleep 3

if systemctl is-active --quiet cidrella; then
  ok "CIDRella is running!"
  CIDRELLA_PID=$(systemctl show cidrella -p MainPID --value 2>/dev/null || true)
  if [ -n "${CIDRELLA_PID:-}" ] && [ "$CIDRELLA_PID" != "0" ] && [ -r "/proc/$CIDRELLA_PID/status" ]; then
    CAP_AMB=$(awk '/^CapAmb:/ {print $2}' "/proc/$CIDRELLA_PID/status")
    CAP_AMB_NET_BIND=0
    CAP_AMB_NET_RAW=0
    if [[ "$CAP_AMB" =~ ^[0-9a-fA-F]+$ ]]; then
      CAP_AMB_NET_BIND=$((16#$CAP_AMB & 0x400))
      CAP_AMB_NET_RAW=$((16#$CAP_AMB & 0x2000))
    fi
    if [ "$CAP_AMB_NET_RAW" -eq 0 ] || [ "$CAP_AMB_NET_BIND" -eq 0 ]; then
      if [ "$CAP_AMB_NET_RAW" -eq 0 ]; then
        warn "cidrella.service is running without ambient CAP_NET_RAW; active ARP and ICMP scans may fail."
        emit_event install warn reason=ambient-cap-missing capability=CAP_NET_RAW "pid=$CIDRELLA_PID"
      fi
      if [ "$CAP_AMB_NET_BIND" -eq 0 ]; then
        warn "cidrella.service is running without ambient CAP_NET_BIND_SERVICE; privileged web/DNS ports may fail."
        emit_event install warn reason=ambient-cap-missing capability=CAP_NET_BIND_SERVICE "pid=$CIDRELLA_PID"
      fi
      warn "Check whether this host/container supports AmbientCapabilities."
    fi
  fi
  emit_event install end result=success "version=$VERSION"
else
  warn "CIDRella service may not have started correctly."
  warn "Check logs: journalctl -u cidrella -f"
  emit_event install end result=service-not-active "version=$VERSION"
fi

# ═══════════════════════════════════════════════════════════
# TIGHTEN SECRET FILE PERMISSIONS (v0.4.8+)
# ═══════════════════════════════════════════════════════════
#
# The actual chmod logic lives in scripts/lib/tighten-secrets.sh so it can
# be shared with update.sh and reused without drift. See that file for the
# rationale and the list of tightened paths.
if [ -f "$INSTALL_DIR/scripts/lib/tighten-secrets.sh" ]; then
  # shellcheck source=scripts/lib/tighten-secrets.sh
  source "$INSTALL_DIR/scripts/lib/tighten-secrets.sh"
  tighten_secrets "$DATA_DIR"
  ok "Tightened secret file permissions (DB, certs, backups, anomaly models → 600/700)"
fi

# ═══════════════════════════════════════════════════════════
# POST-INSTALL HOOK (v0.4.9+)
# ═══════════════════════════════════════════════════════════
#
# Run the release's post-install hook — same convention update.sh uses for
# the upgrade path. For a fresh install, PREV_SLOT is empty and
# IS_FRESH_INSTALL=1 so the hook can branch on install-vs-update if it
# needs to. Non-fatal on error.
POST_INSTALL_HOOK="$INSTALL_DIR/scripts/post-install.sh"
if [ -f "$POST_INSTALL_HOOK" ]; then
  info "Running post-install hook..."
  if TARGET_SLOT="$INSTALL_DIR" PREV_SLOT="" \
     DATA_DIR="$DATA_DIR" NEW_VERSION="$VERSION" \
     OLD_VERSION="" IS_FRESH_INSTALL=1 \
     bash "$POST_INSTALL_HOOK"; then
    ok "Post-install hook completed"
  else
    warn "Post-install hook exited non-zero (install continues)"
  fi
fi

# ═══════════════════════════════════════════════════════════
# EXTRACT ADMIN PASSWORD
# ═══════════════════════════════════════════════════════════

ADMIN_PASSWORD=""
ADMIN_PASSWORD=$(journalctl -u cidrella --no-pager -n 50 2>/dev/null | grep -oP 'Password: \K\S+' | head -1 || true)

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════

# Detect IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="<your-server-ip>"
if [ "${WEB_HTTPS_PORT:-8443}" = "443" ]; then
  WEB_UI_URL="https://${SERVER_IP}"
else
  WEB_UI_URL="https://${SERVER_IP}:${WEB_HTTPS_PORT:-8443}"
fi

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  CIDRella v${VERSION} installed successfully!${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Web UI:${NC}      ${WEB_UI_URL}"
echo -e "  ${BOLD}Data dir:${NC}    ${DATA_DIR}"
echo -e "  ${BOLD}Install dir:${NC} ${INSTALL_LINK} (-> ${INSTALL_DIR})"
echo -e "  ${BOLD}Update:${NC}      cidrella-update"
echo -e "  ${BOLD}Rollback:${NC}    cidrella-rollback"
echo ""
if [ -n "$ADMIN_PASSWORD" ]; then
  echo -e "  ${BOLD}Admin login:${NC}"
  echo -e "    Username: ${GREEN}admin${NC}"
  echo -e "    Password: ${GREEN}${ADMIN_PASSWORD}${NC}"
  echo ""
  echo -e "  ${YELLOW}Save this password — it will not be shown again.${NC}"
  echo -e "  ${YELLOW}You will be prompted to change it on first login.${NC}"
else
  echo -e "  ${BOLD}Admin login:${NC}"
  echo -e "    Check the service logs for the generated password:"
  echo -e "    ${BLUE}journalctl -u cidrella --no-pager | grep Password${NC}"
fi
echo ""
echo -e "  ${BOLD}Services:${NC}"
echo -e "    systemctl status cidrella"
[ "$DNSMASQ_MODE" = "own" ] && echo -e "    systemctl status cidrella-dnsmasq"
echo ""
echo -e "  ${BOLD}Logs:${NC}"
echo -e "    journalctl -u cidrella -f"
echo ""
info "On first visit, you will be guided through initial setup."
echo ""
