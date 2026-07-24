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

# _semver_core <version>
#   Echoes three space-separated integers: major minor patch.
#   Strips any leading 'v' and any pre-release ('-...') or build ('+...') suffix.
_semver_core() {
  local v="${1#v}"
  v="${v%%+*}"
  v="${v%%-*}"
  local IFS=.
  # shellcheck disable=SC2086
  set -- $v
  printf '%d %d %d' "${1:-0}" "${2:-0}" "${3:-0}"
}

# _semver_prerelease <version>
#   Echoes the prerelease suffix (the bit between '-' and any '+'), or empty.
#   v0.4.15-pre.1+abc → "pre.1"
#   v0.4.15           → ""
_semver_prerelease() {
  local v="${1#v}"
  v="${v%%+*}"
  case "$v" in
    *-*) printf '%s' "${v#*-}" ;;
    *)   printf '' ;;
  esac
}

# _semver_cmp_id <a-id> <b-id>
#   Compare two individual prerelease identifiers per semver 2.0:
#   - All-numeric identifiers compare numerically.
#   - Numeric identifiers have lower precedence than alphanumeric.
#   - Alphanumeric identifiers compare lexically (ASCII).
#   Prints -1, 0, or 1.
_semver_cmp_id() {
  local a="$1" b="$2"
  local a_num=0 b_num=0
  case "$a" in ''|*[!0-9]*) a_num=0 ;; *) a_num=1 ;; esac
  case "$b" in ''|*[!0-9]*) b_num=0 ;; *) b_num=1 ;; esac
  if [ "$a_num" = 1 ] && [ "$b_num" = 1 ]; then
    # Both numeric, arithmetic compare.
    if [ "$a" -lt "$b" ]; then printf -- '-1'; return 0; fi
    if [ "$a" -gt "$b" ]; then printf '1'; return 0; fi
    printf '0'; return 0
  fi
  if [ "$a_num" = 1 ] && [ "$b_num" = 0 ]; then printf -- '-1'; return 0; fi
  if [ "$a_num" = 0 ] && [ "$b_num" = 1 ]; then printf '1';  return 0; fi
  # Both alphanumeric, lexical compare.
  if [ "$a" = "$b" ]; then printf '0'; return 0; fi
  if [[ "$a" < "$b" ]]; then printf -- '-1'; return 0; fi
  printf '1'
}

# _semver_cmp_pre <a-pre> <b-pre>
#   Compare two full prerelease strings (after the '-'), dot-split per
#   semver 2.0. Prints -1, 0, or 1.
#   Precedence rules:
#   - No prerelease > has prerelease
#   - Left-to-right identifier compare via _semver_cmp_id
#   - Shorter prefix wins if all compared identifiers are equal
#     (1.0.0-alpha < 1.0.0-alpha.1)
_semver_cmp_pre() {
  local a="$1" b="$2"
  # Empty means "no prerelease", higher precedence than any prerelease.
  if [ -z "$a" ] && [ -z "$b" ]; then printf '0';  return 0; fi
  if [ -z "$a" ];                  then printf '1';  return 0; fi
  if [ -z "$b" ];                  then printf -- '-1'; return 0; fi

  local IFS=.
  # shellcheck disable=SC2206
  local -a aids=($a)
  # shellcheck disable=SC2206
  local -a bids=($b)

  local n_a=${#aids[@]} n_b=${#bids[@]}
  local n=$(( n_a < n_b ? n_a : n_b ))
  local i cmp
  for (( i = 0; i < n; i++ )); do
    cmp=$(_semver_cmp_id "${aids[$i]}" "${bids[$i]}")
    if [ "$cmp" != '0' ]; then printf '%s' "$cmp"; return 0; fi
  done
  if [ "$n_a" -lt "$n_b" ]; then printf -- '-1'; return 0; fi
  if [ "$n_a" -gt "$n_b" ]; then printf '1';  return 0; fi
  printf '0'
}

# semver_cmp <a> <b>
#   Prints -1 if a < b, 0 if a == b, 1 if a > b.
#   Handles prerelease tags per semver 2.0 so comparators work correctly for
#   v0.4.15-pre1 vs v0.4.15, v0.4.15-pre.1 vs v0.4.15-pre.10, etc.
semver_cmp() {
  local a_core b_core a_pre b_pre
  a_core=$(_semver_core "$1") || return 1
  b_core=$(_semver_core "$2") || return 1
  a_pre=$(_semver_prerelease "$1")
  b_pre=$(_semver_prerelease "$2")

  local a1 a2 a3 b1 b2 b3
  read -r a1 a2 a3 <<< "$a_core"
  read -r b1 b2 b3 <<< "$b_core"
  if [ "$a1" -lt "$b1" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a1" -gt "$b1" ]; then printf '1\n';  return 0; fi
  if [ "$a2" -lt "$b2" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a2" -gt "$b2" ]; then printf '1\n';  return 0; fi
  if [ "$a3" -lt "$b3" ]; then printf -- '-1\n'; return 0; fi
  if [ "$a3" -gt "$b3" ]; then printf '1\n';  return 0; fi
  # Cores equal, fall through to prerelease compare.
  local pre_cmp
  pre_cmp=$(_semver_cmp_pre "$a_pre" "$b_pre")
  printf '%s\n' "$pre_cmp"
}

semver_lt() { [ "$(semver_cmp "$1" "$2")" = "-1" ]; }
semver_gt() { [ "$(semver_cmp "$1" "$2")" = "1" ]; }
semver_eq() { [ "$(semver_cmp "$1" "$2")" = "0" ]; }

# Backwards-compat shim for scripts written against the old helper name. Prints
# "major minor patch" (no prerelease). New code should use _semver_core.
_semver_parts() { _semver_core "$1"; }
