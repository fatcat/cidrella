#!/bin/bash
# CIDRella signature + integrity verification helpers.
#
# Source this file; do not execute it. Provides:
#   - verify_minisign <tarball> <sig> <pubkey>: hard-fail signature check
#   - verify_sha256   <file> <expected-hex>:    integrity check against known hash
#   - verify_release_json <path> <expected-version>:
#       Sanity-checks a RELEASE.json file and confirms its `version` field.
#
# Depends on log.sh (info/ok/warn/err). Caller must source log.sh first.

if [ "${__CIDRELLA_VERIFY_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_VERIFY_LIB_LOADED=1

# verify_minisign <tarball> <sig> <pubkey>
#   Returns 0 on verified signature, 1 on verification failure,
#   2 if minisign is not installed (caller decides whether to proceed).
verify_minisign() {
  local tarball="${1:?tarball path required}"
  local sig="${2:?signature path required}"
  local pubkey="${3:?pubkey path required}"

  if ! command -v minisign >/dev/null 2>&1; then
    return 2
  fi
  if [ ! -f "$tarball" ] || [ ! -f "$sig" ] || [ ! -f "$pubkey" ]; then
    return 1
  fi
  if minisign -Vm "$tarball" -x "$sig" -p "$pubkey" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# verify_sha256 <file> <expected-hex>
#   Returns 0 if the file's SHA-256 matches expected, 1 otherwise.
verify_sha256() {
  local file="${1:?file path required}"
  local expected="${2:?expected hash required}"
  [ -f "$file" ] || return 1
  local actual
  actual=$(sha256sum "$file" 2>/dev/null | awk '{print $1}')
  [ "$actual" = "$expected" ]
}

# verify_release_json <path> <expected-version>
#   Reads a RELEASE.json file and confirms it is a well-formed object with
#   a "version" field matching <expected-version>. Uses node if available,
#   falling back to a grep parse.
#   Returns 0 on match, 1 on mismatch or parse failure.
verify_release_json() {
  local path="${1:?release.json path required}"
  local expected="${2:?expected version required}"
  [ -f "$path" ] || return 1

  local version=""
  local node_bin=""
  if [ -x /usr/local/bin/cidrella-node ]; then
    node_bin=/usr/local/bin/cidrella-node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  fi

  if [ -n "$node_bin" ]; then
    version=$(REL_PATH="$path" "$node_bin" -e "
      try {
        const fs = require('fs');
        const r = JSON.parse(fs.readFileSync(process.env.REL_PATH, 'utf8'));
        if (typeof r.version === 'string') process.stdout.write(r.version);
      } catch (_) {}
    " 2>/dev/null)
  fi

  if [ -z "$version" ]; then
    version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path" | head -n 1)
  fi

  [ "$version" = "$expected" ]
}
