#!/bin/bash
# CIDRella radvd install helpers, shared by install.sh and update.sh.
#
# Source this file; do not execute it. Provides:
#   - install_radvd <slot>: the distribution's radvd package and the
#     cidrella-radvd unit. Returns nonzero on failure; radvd is needed only
#     by the PowerDNS + Kea stack (dnsmasq sends its own Router
#     Advertisements), so callers warn and carry on.
#   - radvd_installed: is the radvd package installed.
#
# It never starts, stops or restarts radvd: CIDRella runs it only while the
# PowerDNS + Kea stack serves, the same rule updates follow for dnsmasq, Kea
# and PowerDNS.
#
# Depends on log.sh and systemd-install.sh. Caller must source both first.

if [ "${__CIDRELLA_RADVD_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_RADVD_LIB_LOADED=1

# install_radvd <slot>
# radvd_installed: is the radvd package installed.
radvd_installed() {
  dpkg-query -W -f='${Status}' radvd 2>/dev/null | grep -q 'install ok installed'
}

install_radvd() {
  local slot="${1:?slot path required}"

  if ! radvd_installed; then
    info "radvd: installing (first time only)..."
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq radvd >/dev/null 2>&1; then
      warn "radvd: apt-get install radvd failed"
      return 1
    fi
    ok "radvd installed"
  fi

  # The package's own unit would advertise from /etc/radvd.conf. Masking
  # keeps an operator's `systemctl start radvd` from starting it either.
  if systemctl list-unit-files radvd.service 2>/dev/null | grep -q '^radvd\.service'; then
    systemctl stop radvd 2>/dev/null || true
    systemctl mask radvd >/dev/null 2>&1 || true
  fi

  install -d -m 0750 -o cidrella -g cidrella "${DATA_DIR:-/var/lib/cidrella}/radvd"
  install_systemd_unit "$slot/scripts/systemd/cidrella-radvd.service" \
    /etc/systemd/system/cidrella-radvd.service >/dev/null || return 1
  return 0
}
