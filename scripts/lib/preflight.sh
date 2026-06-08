#!/bin/bash
# CIDRella preflight checks.
#
# Source this file; do not execute it. Provides:
#   - load_requirements <path>:   reads requirements.json into env vars
#   - check_ram:                  verifies available RAM >= REQ_MIN_RAM_MB
#   - check_disk <path>:          verifies free space at <path> >= REQ_MIN_DISK_MB
#   - check_glibc:                verifies glibc >= REQ_MIN_GLIBC
#   - check_dnsmasq:              verifies dnsmasq present and >= REQ_MIN_DNSMASQ
#   - check_clock:                warns if system clock appears skewed
#   - run_all_preflight <path>:   loads requirements.json and runs every check;
#                                 returns 0 if all pass, 1 if any fail.
#
# Depends on log.sh. Caller must source log.sh first.

if [ "${__CIDRELLA_PREFLIGHT_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_PREFLIGHT_LIB_LOADED=1

# load_requirements <requirements.json path>
#   Parses requirements.json (via node if available, fallback grep) and
#   exports REQ_MIN_* environment variables:
#     REQ_MIN_DEBIAN, REQ_MIN_GLIBC, REQ_MIN_DNSMASQ,
#     REQ_MIN_RAM_MB, REQ_MIN_DISK_MB, REQ_BUNDLED_NODE_VERSION
load_requirements() {
  local path="${1:?requirements.json path required}"
  [ -f "$path" ] || { err "requirements.json not found at $path"; return 1; }

  local node_bin=""
  if [ -x /usr/local/bin/cidrella-node ]; then
    node_bin=/usr/local/bin/cidrella-node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi

  if [ -n "$node_bin" ]; then
    local parsed
    parsed=$(REQ_PATH="$path" "$node_bin" -e "
      const fs = require('fs');
      const r = JSON.parse(fs.readFileSync(process.env.REQ_PATH, 'utf8'));
      const out = [];
      out.push('REQ_MIN_DEBIAN=' + JSON.stringify(String(r.min_debian || '')));
      out.push('REQ_MIN_GLIBC=' + JSON.stringify(String(r.min_glibc || '')));
      out.push('REQ_MIN_DNSMASQ=' + JSON.stringify(String(r.min_dnsmasq || '')));
      out.push('REQ_MIN_RAM_MB=' + JSON.stringify(String(r.min_ram_mb || 0)));
      out.push('REQ_MIN_DISK_MB=' + JSON.stringify(String(r.min_disk_mb || 0)));
      out.push('REQ_BUNDLED_NODE_VERSION=' + JSON.stringify(String(r.bundled_node_version || '')));
      process.stdout.write(out.join('\n'));
    " 2>/dev/null) && [ -n "$parsed" ] && { eval "$parsed"; export REQ_MIN_DEBIAN REQ_MIN_GLIBC REQ_MIN_DNSMASQ REQ_MIN_RAM_MB REQ_MIN_DISK_MB REQ_BUNDLED_NODE_VERSION; return 0; }
  fi

  REQ_MIN_DEBIAN=$(sed -n 's/.*"min_debian"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'   "$path" | head -n1)
  REQ_MIN_GLIBC=$(sed -n  's/.*"min_glibc"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'    "$path" | head -n1)
  REQ_MIN_DNSMASQ=$(sed -n 's/.*"min_dnsmasq"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path" | head -n1)
  REQ_MIN_RAM_MB=$(sed -n  's/.*"min_ram_mb"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p'  "$path" | head -n1)
  REQ_MIN_DISK_MB=$(sed -n 's/.*"min_disk_mb"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$path" | head -n1)
  REQ_BUNDLED_NODE_VERSION=$(sed -n 's/.*"bundled_node_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path" | head -n1)
  export REQ_MIN_DEBIAN REQ_MIN_GLIBC REQ_MIN_DNSMASQ REQ_MIN_RAM_MB REQ_MIN_DISK_MB REQ_BUNDLED_NODE_VERSION
}

check_ram() {
  local min_mb="${REQ_MIN_RAM_MB:-512}"
  local total_kb
  total_kb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)
  [ -n "$total_kb" ] || { warn "Could not read /proc/meminfo"; return 0; }
  local total_mb=$((total_kb / 1024))
  if [ "$total_mb" -lt "$min_mb" ]; then
    err "Insufficient RAM: ${total_mb}MB total, need at least ${min_mb}MB."
    return 1
  fi
  return 0
}

check_disk() {
  local path="${1:-/opt}"
  local min_mb="${REQ_MIN_DISK_MB:-2000}"
  local free_mb
  free_mb=$(df -Pm "$path" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$free_mb" ] || { warn "Could not read disk space for $path"; return 0; }
  if [ "$free_mb" -lt "$min_mb" ]; then
    err "Insufficient disk space at $path: ${free_mb}MB free, need at least ${min_mb}MB."
    return 1
  fi
  return 0
}

check_glibc() {
  local min="${REQ_MIN_GLIBC:-2.36}"
  local actual
  actual=$(ldd --version 2>/dev/null | awk 'NR==1 {print $NF}')
  [ -n "$actual" ] || { warn "Could not determine glibc version"; return 0; }
  # Numeric compare on major.minor
  local a_maj a_min m_maj m_min
  a_maj=${actual%%.*}; a_min=${actual#*.}; a_min=${a_min%%.*}
  m_maj=${min%%.*};    m_min=${min#*.};    m_min=${m_min%%.*}
  if [ "$a_maj" -lt "$m_maj" ] || { [ "$a_maj" -eq "$m_maj" ] && [ "$a_min" -lt "$m_min" ]; }; then
    err "glibc ${actual} is older than required ${min}"
    return 1
  fi
  return 0
}

check_dnsmasq() {
  local min="${REQ_MIN_DNSMASQ:-2.87}"
  if ! command -v dnsmasq >/dev/null 2>&1; then
    warn "dnsmasq not installed (will be installed by install.sh)"
    return 0
  fi
  local actual
  actual=$(dnsmasq --version 2>/dev/null | awk 'NR==1 {print $3}')
  [ -n "$actual" ] || return 0
  local a_maj a_min m_maj m_min
  a_maj=${actual%%.*}; a_min=${actual#*.}; a_min=${a_min%%.*}
  m_maj=${min%%.*};    m_min=${min#*.};    m_min=${m_min%%.*}
  if [ "$a_maj" -lt "$m_maj" ] || { [ "$a_maj" -eq "$m_maj" ] && [ "$a_min" -lt "$m_min" ]; }; then
    warn "dnsmasq ${actual} is older than recommended ${min}"
  fi
  return 0
}

check_clock() {
  if command -v timedatectl >/dev/null 2>&1; then
    if ! timedatectl show 2>/dev/null | grep -q 'NTPSynchronized=yes'; then
      # Preflight runs as root during install/update — try to enable NTP so
      # DNSSEC signature-time validation doesn't SERVFAIL on a skewed clock.
      # (Sync itself is asynchronous; we just make sure the client is on.)
      if ! timedatectl show -p NTP --value 2>/dev/null | grep -qx yes; then
        timedatectl set-ntp true >/dev/null 2>&1 || true
      fi
      if ! timedatectl show 2>/dev/null | grep -q 'NTPSynchronized=yes'; then
        warn "System clock is not NTP-synchronized — DNSSEC signature timestamps may be off until sync completes"
      fi
    fi
  fi
  return 0
}

# run_all_preflight <requirements.json path> [disk-check path]
#   Returns 0 if all hard checks pass, 1 if any hard check fails.
#   Soft checks (clock, dnsmasq) only emit warnings.
run_all_preflight() {
  local req_path="${1:?requirements.json path required}"
  local disk_path="${2:-/opt}"
  load_requirements "$req_path" || return 1
  local fail=0
  check_ram  || fail=1
  check_disk "$disk_path" || fail=1
  check_glibc || fail=1
  check_dnsmasq
  check_clock
  return "$fail"
}
