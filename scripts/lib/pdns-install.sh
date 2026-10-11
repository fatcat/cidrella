#!/bin/bash
# CIDRella PowerDNS install helpers, shared by install.sh and update.sh.
#
# Source this file; do not execute it. Provides:
#   - install_pdns <slot>: PowerDNS's own repository (Authoritative 5.0 and
#     Recursor 5.3), the packages, and the cidrella-pdns-auth and
#     cidrella-pdns-recursor units. Returns nonzero on failure; PowerDNS is
#     optional (dnsmasq serves DNS without it), so callers warn and carry on.
#
# It never starts, stops or restarts PowerDNS: CIDRella runs it only while it
# serves DNS, the same rule updates follow for dnsmasq and Kea.
#
# Depends on log.sh and systemd-install.sh. Caller must source both first.

if [ "${__CIDRELLA_PDNS_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_PDNS_LIB_LOADED=1

PDNS_REPO_URL="https://repo.powerdns.com"
# The series CIDRella is tested against. Authoritative 5.1.4's API refuses a
# TXT value holding a double quote or a byte above 127 (verified 2026-10-10),
# so it stays on 5.0 until a 5.1 release fixes that.
PDNS_AUTH_SERIES="auth-50"
PDNS_REC_SERIES="rec-53"
PDNS_KEYRING="/usr/share/keyrings/powerdns-archive-keyring.gpg"
PDNS_SOURCES="/etc/apt/sources.list.d/powerdns.list"
PDNS_PREFERENCES="/etc/apt/preferences.d/powerdns"
# PowerDNS Release Signing Key, which signs both repositories.
PDNS_KEY_FINGERPRINT="9FAAA5577E8FCF62093D036C1B0C6205FD380FBB"
PDNS_PACKAGES="pdns-server pdns-backend-sqlite3 pdns-recursor"

# _pdns_repo: the keyring (fingerprint checked), the sources list, and a pin
# so these packages come from PowerDNS rather than the distribution, whose
# versions differ.
_pdns_repo() {
  # shellcheck source=/dev/null
  . /etc/os-release
  local distro="${ID:-}" codename="${VERSION_CODENAME:-}"
  case "$distro" in
    debian|ubuntu) ;;
    *) warn "PowerDNS: no PowerDNS packages for distribution '${distro:-unknown}'"; return 1 ;;
  esac
  if [ -z "$codename" ]; then
    warn "PowerDNS: /etc/os-release names no VERSION_CODENAME"
    return 1
  fi

  if ! command -v gpg >/dev/null 2>&1; then
    apt-get install -y -qq gnupg >/dev/null 2>&1 || { warn "PowerDNS: could not install gnupg"; return 1; }
  fi

  local tmp
  tmp=$(mktemp -d) || return 1
  if ! curl -fsSL "$PDNS_REPO_URL/FD380FBB-pub.asc" -o "$tmp/key.asc"; then
    warn "PowerDNS: could not download the signing key from $PDNS_REPO_URL/FD380FBB-pub.asc"
    rm -rf "$tmp"
    return 1
  fi
  local found
  found=$(gpg --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')
  if [ "$found" != "$PDNS_KEY_FINGERPRINT" ]; then
    warn "PowerDNS: the signing key has fingerprint '${found:-none}', expected $PDNS_KEY_FINGERPRINT. Not adding the repository."
    rm -rf "$tmp"
    return 1
  fi
  gpg --dearmor --yes -o "$PDNS_KEYRING" "$tmp/key.asc" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  chmod 0644 "$PDNS_KEYRING"
  rm -rf "$tmp"

  local lines
  lines=$(printf 'deb [signed-by=%s] %s/%s %s-%s main\n' \
    "$PDNS_KEYRING" "$PDNS_REPO_URL" "$distro" "$codename" "$PDNS_AUTH_SERIES" \
    "$PDNS_KEYRING" "$PDNS_REPO_URL" "$distro" "$codename" "$PDNS_REC_SERIES")
  if [ ! -f "$PDNS_SOURCES" ] || [ "$(cat "$PDNS_SOURCES")" != "$lines" ]; then
    printf '%s\n' "$lines" > "$PDNS_SOURCES"
    chmod 0644 "$PDNS_SOURCES"
  fi
  printf 'Package: pdns-*\nPin: origin repo.powerdns.com\nPin-Priority: 600\n' > "$PDNS_PREFERENCES"
  chmod 0644 "$PDNS_PREFERENCES"
  apt-get update -qq -o Dir::Etc::sourcelist="$PDNS_SOURCES" -o Dir::Etc::sourceparts=- \
    -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 || { warn "PowerDNS: apt-get update of PowerDNS's repository failed"; return 1; }
}

# _pdns_from_repo: are the installed packages PowerDNS's own builds? Debian
# carries pdns-server too, an older Authoritative.
_pdns_from_repo() {
  local pkg version
  for pkg in $PDNS_PACKAGES; do
    version=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null) || return 1
    case "$version" in
      *pdns*) ;;
      *) return 1 ;;
    esac
  done
}

# install_pdns <slot>
install_pdns() {
  local slot="${1:?slot path required}"

  if ! _pdns_from_repo; then
    _pdns_repo || return 1
    # shellcheck disable=SC2086
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PDNS_PACKAGES >/dev/null 2>&1; then
      warn "PowerDNS: apt-get install $PDNS_PACKAGES failed"
      return 1
    fi
  fi

  # The packages' own units would take port 53 from CIDRella. Masking keeps
  # an operator's `systemctl start` from starting them either.
  local unit
  for unit in pdns pdns-recursor; do
    if systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit\.service"; then
      systemctl stop "$unit" 2>/dev/null || true
      systemctl mask "$unit" >/dev/null 2>&1 || true
    fi
  done

  install -d -m 0750 -o cidrella -g cidrella "${DATA_DIR:-/var/lib/cidrella}/pdns"
  install_systemd_unit "$slot/scripts/systemd/cidrella-pdns-auth.service" \
    /etc/systemd/system/cidrella-pdns-auth.service >/dev/null || return 1
  install_systemd_unit "$slot/scripts/systemd/cidrella-pdns-recursor.service" \
    /etc/systemd/system/cidrella-pdns-recursor.service >/dev/null || return 1
  return 0
}
