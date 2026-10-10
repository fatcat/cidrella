#!/bin/bash
# CIDRella Kea install helpers, shared by install.sh and update.sh.
#
# Source this file; do not execute it. Provides:
#   - install_kea <slot>: ISC's Kea 3.0 repository and packages, the
#     cidrella account in group _kea, and the cidrella-kea@ unit. Returns
#     nonzero on failure; Kea is optional (dnsmasq serves DHCP without it),
#     so callers warn and carry on.
#
# It never starts, stops or restarts Kea: CIDRella runs it only while it is
# the DHCP server, the same rule updates follow for dnsmasq.
#
# Depends on log.sh and systemd-install.sh. Caller must source both first.

if [ "${__CIDRELLA_KEA_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_KEA_LIB_LOADED=1

KEA_REPO_URL="https://dl.cloudsmith.io/public/isc/kea-3-0"
KEA_KEYRING="/usr/share/keyrings/isc-kea-3-0-archive-keyring.gpg"
KEA_SOURCES="/etc/apt/sources.list.d/isc-kea-3-0.list"
# ISC's Cloudsmith signing key for the kea-3-0 repository.
KEA_KEY_FINGERPRINT="9DA570BB192211885E4EB280B16C44CD45514C3C"
KEA_PACKAGES="isc-kea-dhcp4 isc-kea-dhcp6 isc-kea-hooks"

# _kea_repo: the keyring (fingerprint checked) and the sources list. Debian
# and Ubuntu each have their own tree, named by distribution and codename.
_kea_repo() {
  # shellcheck source=/dev/null
  . /etc/os-release
  local distro="${ID:-}" codename="${VERSION_CODENAME:-}"
  case "$distro" in
    debian|ubuntu) ;;
    *) warn "Kea: no ISC packages for distribution '${distro:-unknown}'"; return 1 ;;
  esac
  if [ -z "$codename" ]; then
    warn "Kea: /etc/os-release names no VERSION_CODENAME"
    return 1
  fi

  if ! command -v gpg >/dev/null 2>&1; then
    apt-get install -y -qq gnupg >/dev/null 2>&1 || { warn "Kea: could not install gnupg"; return 1; }
  fi

  local tmp
  tmp=$(mktemp -d) || return 1
  if ! curl -fsSL "$KEA_REPO_URL/gpg.key" -o "$tmp/key.asc"; then
    warn "Kea: could not download ISC's signing key from $KEA_REPO_URL/gpg.key"
    rm -rf "$tmp"
    return 1
  fi
  local found
  found=$(gpg --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')
  if [ "$found" != "$KEA_KEY_FINGERPRINT" ]; then
    warn "Kea: ISC's signing key has fingerprint '${found:-none}', expected $KEA_KEY_FINGERPRINT. Not adding the repository."
    rm -rf "$tmp"
    return 1
  fi
  gpg --dearmor --yes -o "$KEA_KEYRING" "$tmp/key.asc" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  chmod 0644 "$KEA_KEYRING"
  rm -rf "$tmp"

  local line="deb [signed-by=$KEA_KEYRING] $KEA_REPO_URL/deb/$distro $codename main"
  if [ ! -f "$KEA_SOURCES" ] || [ "$(cat "$KEA_SOURCES")" != "$line" ]; then
    printf '%s\n' "$line" > "$KEA_SOURCES"
    chmod 0644 "$KEA_SOURCES"
  fi
  apt-get update -qq -o Dir::Etc::sourcelist="$KEA_SOURCES" -o Dir::Etc::sourceparts=- \
    -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 || { warn "Kea: apt-get update of ISC's repository failed"; return 1; }
}

# install_kea <slot>
install_kea() {
  local slot="${1:?slot path required}"

  if ! dpkg -s $KEA_PACKAGES >/dev/null 2>&1; then
    _kea_repo || return 1
    # shellcheck disable=SC2086
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $KEA_PACKAGES >/dev/null 2>&1; then
      warn "Kea: apt-get install $KEA_PACKAGES failed"
      return 1
    fi
  fi

  # ISC's own units would take ports 67 and 547 from dnsmasq. They are not
  # enabled on install; masking keeps an operator's `systemctl start` from
  # starting them either.
  local unit
  for unit in isc-kea-dhcp4-server isc-kea-dhcp6-server isc-kea-ctrl-agent isc-kea-dhcp-ddns-server; do
    if systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit\.service"; then
      systemctl stop "$unit" 2>/dev/null || true
      systemctl mask "$unit" >/dev/null 2>&1 || true
    fi
  done

  # The daemons are root:_kea 0750, and CIDRella runs `kea-dhcp4 -t` itself.
  # cidrella.service picks the group up at its next start.
  if getent group _kea >/dev/null 2>&1; then
    usermod -aG _kea cidrella || { warn "Kea: could not add cidrella to group _kea"; return 1; }
  fi

  install -d -m 0750 -o cidrella -g cidrella "${DATA_DIR:-/var/lib/cidrella}/kea"
  install_systemd_unit "$slot/scripts/systemd/cidrella-kea@.service" \
    /etc/systemd/system/cidrella-kea@.service >/dev/null || return 1
  return 0
}
