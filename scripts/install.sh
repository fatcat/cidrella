#!/bin/bash
set -euo pipefail

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
INSTALL_DIR="/opt/cidrella"
DATA_DIR="/var/lib/cidrella"
SERVICE_USER="cidrella"
REQUESTED_VERSION=""
FORCE_INSTALL=false
NODE_MAJOR=20

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
      echo "Or: /opt/cidrella/scripts/update.sh"
      exit 0
      ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ═══════════════════════════════════════════════════════════
# PREFLIGHT CHECKS
# ═══════════════════════════════════════════════════════════

echo -e "\n${BOLD}═══ CIDRella Installer ═══${NC}\n"

# Must be root
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or with sudo)."
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

# Check for existing installation
if [ -d "$INSTALL_DIR" ]; then
  if [ ! -f "$INSTALL_DIR/package.json" ]; then
    warn "Partial installation detected at $INSTALL_DIR. Continuing install..."
  elif [ "$FORCE_INSTALL" = true ]; then
    warn "Overwriting existing installation at $INSTALL_DIR (--force)."
  else
    warn "CIDRella is already installed at $INSTALL_DIR."
    if [ -f "$INSTALL_DIR/scripts/update.sh" ]; then
      info "To update, run: $INSTALL_DIR/scripts/update.sh"
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
# NODE.JS
# ═══════════════════════════════════════════════════════════

info "Checking Node.js..."
CURRENT_NODE_MAJOR=0
if command -v node &>/dev/null; then
  CURRENT_NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
fi

if [ "$CURRENT_NODE_MAJOR" -ge "$NODE_MAJOR" ]; then
  ok "Node.js $(node -v) found."
else
  if [ "$CURRENT_NODE_MAJOR" -gt 0 ]; then
    warn "Node.js v${CURRENT_NODE_MAJOR} found, but v${NODE_MAJOR}+ is required."
  else
    info "Node.js not found."
  fi

  info "Installing Node.js ${NODE_MAJOR}.x via NodeSource..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v) installed."
fi

# ═══════════════════════════════════════════════════════════
# SYSTEM PACKAGES
# ═══════════════════════════════════════════════════════════

info "Installing system dependencies..."
apt-get install -y -qq build-essential nmap arping openssl curl dnsutils rsync sudo >/dev/null 2>&1
ok "System packages installed."

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

# Create data directories
mkdir -p "$DATA_DIR"/{certs,backups,dnsmasq/{hosts.d,dhcp-hosts.d,conf.d},blocklists,geoip}
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
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR/cidrella.tar.gz" -C "$TMPDIR"

# Find the extracted directory (might be nested)
EXTRACTED=$(find "$TMPDIR" -maxdepth 1 -type d -name "cidrella*" | head -1)
if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "$TMPDIR" ]; then
  # Tarball might extract files directly
  EXTRACTED="$TMPDIR"
fi

# Copy to install directory
rsync -a --delete "$EXTRACTED/" "$INSTALL_DIR/"
ok "Extracted to $INSTALL_DIR"

# ═══════════════════════════════════════════════════════════
# INSTALL NODE DEPENDENCIES
# ═══════════════════════════════════════════════════════════

info "Installing Node.js dependencies (this may take a moment)..."
cd "$INSTALL_DIR/server"
npm install --production --silent 2>&1 | tail -5
ok "Dependencies installed."

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

cp "$INSTALL_DIR/scripts/systemd/cidrella.service" /etc/systemd/system/
ok "Installed cidrella.service"

if [ "$DNSMASQ_MODE" = "own" ]; then
  cp "$INSTALL_DIR/scripts/systemd/cidrella-dnsmasq.service" /etc/systemd/system/
  ok "Installed cidrella-dnsmasq.service"
fi

# Install sudoers
cp "$INSTALL_DIR/scripts/sudoers/cidrella" /etc/sudoers.d/cidrella
chmod 440 /etc/sudoers.d/cidrella
ok "Installed sudoers rules."

# Set Node.js capabilities for raw socket access
setcap cap_net_raw+ep "$(readlink -f "$(which node)")" 2>/dev/null || warn "Could not set capabilities on node binary."

systemctl daemon-reload

# ═══════════════════════════════════════════════════════════
# CREATE UPDATE SYMLINK
# ═══════════════════════════════════════════════════════════

if [ -f "$INSTALL_DIR/scripts/update.sh" ]; then
  ln -sf "$INSTALL_DIR/scripts/update.sh" /usr/local/bin/cidrella-update
  chmod +x "$INSTALL_DIR/scripts/update.sh"
  ok "Update command: cidrella-update"
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

# Wait briefly for startup
sleep 3

if systemctl is-active --quiet cidrella; then
  ok "CIDRella is running!"
else
  warn "CIDRella service may not have started correctly."
  warn "Check logs: journalctl -u cidrella -f"
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

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  CIDRella v${VERSION} installed successfully!${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Web UI:${NC}      https://${SERVER_IP}:8443"
echo -e "  ${BOLD}Data dir:${NC}    ${DATA_DIR}"
echo -e "  ${BOLD}Install dir:${NC} ${INSTALL_DIR}"
echo -e "  ${BOLD}Update:${NC}      cidrella-update"
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
