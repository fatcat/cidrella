#!/bin/bash
# CIDRella A/B slot + version helpers.
#
# Source this file; do not execute it. Provides:
#   - detect_active_slot: sets ACTIVE_SLOT / TARGET_SLOT based on $INSTALL_LINK
#   - read_slot_version: prints the package.json version from a slot path
#   - semver_lt / semver_gt / semver_eq: pure-bash semver comparison
#
# Callers must pre-set $INSTALL_LINK (default /opt/cidrella), $SLOT_A, $SLOT_B.

if [ "${__CIDRELLA_SLOTS_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_SLOTS_LIB_LOADED=1

: "${INSTALL_LINK:=/opt/cidrella}"
: "${SLOT_A:=/opt/cidrella-a}"
: "${SLOT_B:=/opt/cidrella-b}"

# detect_active_slot
#   Exits nonzero (caller should handle) if $INSTALL_LINK is not a symlink
#   pointing at one of $SLOT_A or $SLOT_B.
#   On success: sets ACTIVE_SLOT and TARGET_SLOT in the calling shell.
detect_active_slot() {
  if [ ! -L "$INSTALL_LINK" ]; then
    return 1
  fi
  local resolved
  resolved=$(readlink -f "$INSTALL_LINK" 2>/dev/null) || return 1
  case "$resolved" in
    "$SLOT_A") ACTIVE_SLOT="$SLOT_A"; TARGET_SLOT="$SLOT_B" ;;
    "$SLOT_B") ACTIVE_SLOT="$SLOT_B"; TARGET_SLOT="$SLOT_A" ;;
    *) return 2 ;;
  esac
  return 0
}

# read_slot_version <slot-path>
#   Prints the version string from <slot>/package.json, or "unknown" if the
#   file can't be read. Uses node if available (preferred for correctness),
#   falling back to a grep-based parse.
read_slot_version() {
  local slot="${1:-}"
  local pkg="$slot/package.json"
  [ -f "$pkg" ] || { printf 'unknown\n'; return 1; }

  local node_bin=""
  if [ -x /usr/local/bin/cidrella-node ]; then
    node_bin=/usr/local/bin/cidrella-node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi

  if [ -n "$node_bin" ]; then
    "$node_bin" -e "process.stdout.write(require('$pkg').version || 'unknown')" 2>/dev/null && return 0
  fi

  # Fallback: grep parse (works for well-formed package.json)
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1
}

# _semver_parts <version>
#   Echoes three space-separated integers: major minor patch.
#   Strips any leading 'v' and any pre-release/build suffix after '-' or '+'.
_semver_parts() {
  local v="${1#v}"
  v="${v%%-*}"
  v="${v%%+*}"
  local IFS=.
  # shellcheck disable=SC2086
  set -- $v
  printf '%d %d %d' "${1:-0}" "${2:-0}" "${3:-0}"
}

# semver_cmp <a> <b>
#   Prints -1 if a < b, 0 if a == b, 1 if a > b.
semver_cmp() {
  local a b
  a=$(_semver_parts "$1") || return 1
  b=$(_semver_parts "$2") || return 1
  local a1 a2 a3 b1 b2 b3
  read -r a1 a2 a3 <<< "$a"
  read -r b1 b2 b3 <<< "$b"
  if [ "$a1" -lt "$b1" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a1" -gt "$b1" ]; then printf '1\n'; return 0; fi
  if [ "$a2" -lt "$b2" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a2" -gt "$b2" ]; then printf '1\n'; return 0; fi
  if [ "$a3" -lt "$b3" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a3" -gt "$b3" ]; then printf '1\n'; return 0; fi
  printf '0\n'
}

semver_lt() { [ "$(semver_cmp "$1" "$2")" = "-1" ]; }
semver_gt() { [ "$(semver_cmp "$1" "$2")" = "1" ]; }
semver_eq() { [ "$(semver_cmp "$1" "$2")" = "0" ]; }
