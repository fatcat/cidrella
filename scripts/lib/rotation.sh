#!/bin/bash
# CIDRella key rotation consumption library.
#
# Source this file; do not execute it. Provides:
#   - load_key_state:       populates KEY_STATE_* env vars from .key-state.json
#   - save_key_state:       writes KEY_STATE_* env vars back to .key-state.json
#   - current_primary_pubkey_file:   emits path to a pubkey file for the current
#                                    trusted primary (for `minisign -p ...`)
#   - current_break_glass_pubkey_file: same for break-glass
#   - fetch_rotation_announcements:  walks the release JSON, downloads any
#                                    rotation-announcement-*.json + .minisig
#   - apply_rotation_announcements:  verifies each, applies those with
#                                    sequence_number > max_seen, updates state
#
# The state file lives at $DATA_DIR/.key-state.json (default /var/lib/cidrella):
#   {
#     "max_seen_sequence_number": 0,
#     "primary_pubkey": "RWR...",        (or null to use shipped scripts/cidrella.pub)
#     "break_glass_pubkey": "RWR...",    (or null to use shipped scripts/cidrella-break-glass.pub)
#     "last_rotation_applied_at": "ISO8601"
#   }
#
# Depends on log.sh (info/ok/warn/err) and verify.sh (verify_minisign).
# Caller must source those first.

if [ "${__CIDRELLA_ROTATION_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_ROTATION_LIB_LOADED=1

: "${DATA_DIR:=/var/lib/cidrella}"
: "${INSTALL_LINK:=/opt/cidrella}"
KEY_STATE_FILE="$DATA_DIR/.key-state.json"

# State variables populated by load_key_state. If the file doesn't exist
# or lacks a field, the variable is empty, and callers fall back to the
# shipped .pub files in $INSTALL_LINK/scripts/.
KEY_STATE_MAX_SEEN=""
KEY_STATE_PRIMARY=""
KEY_STATE_BREAK_GLASS=""
KEY_STATE_LAST_APPLIED=""

# _rotation_node: resolve the node binary we'll use to parse JSON. Prefer
# the cidrella-node wrapper, fall back to system node. Used by every helper
# that needs JSON parsing (we don't depend on jq being installed).
_rotation_node() {
  if [ -x /usr/local/bin/cidrella-node ]; then
    printf '%s\n' /usr/local/bin/cidrella-node
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

# load_key_state
#   Reads $KEY_STATE_FILE if present. Populates KEY_STATE_* env vars.
#   Missing file is not an error — callers fall through to shipped pubkeys.
load_key_state() {
  KEY_STATE_MAX_SEEN=""
  KEY_STATE_PRIMARY=""
  KEY_STATE_BREAK_GLASS=""
  KEY_STATE_LAST_APPLIED=""

  if [ ! -f "$KEY_STATE_FILE" ]; then
    return 0
  fi

  local node_bin
  node_bin=$(_rotation_node) || return 0

  # Emit one value per line (no prefix, no shell-quoting) and read with the
  # `read` builtin, so no `eval`. Pubkey/date/integer values never contain
  # embedded newlines, so line-per-field is unambiguous. A malicious
  # .key-state.json that stuffed shell metacharacters into `primary_pubkey`
  # cannot escape `read` because `read` treats its input as literal bytes.
  local parsed
  parsed=$(KEY_STATE_PATH="$KEY_STATE_FILE" "$node_bin" -e "
    try {
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync(process.env.KEY_STATE_PATH, 'utf8'));
      const clean = v => String(v == null ? '' : v).replace(/[\r\n]/g, '');
      process.stdout.write(
        clean(s.max_seen_sequence_number || 0) + '\n' +
        clean(s.primary_pubkey) + '\n' +
        clean(s.break_glass_pubkey) + '\n' +
        clean(s.last_rotation_applied_at) + '\n'
      );
    } catch (e) {
      process.stderr.write('key-state parse error: ' + e.message);
      process.exit(1);
    }
  " 2>/dev/null) || {
    warn "Could not parse $KEY_STATE_FILE — using shipped pubkeys"
    return 0
  }
  {
    IFS= read -r KEY_STATE_MAX_SEEN
    IFS= read -r KEY_STATE_PRIMARY
    IFS= read -r KEY_STATE_BREAK_GLASS
    IFS= read -r KEY_STATE_LAST_APPLIED
  } <<< "$parsed"
}

# save_key_state <max_seen> <primary_pubkey_or_empty> <break_glass_pubkey_or_empty>
#   Writes the key state file atomically. Creates the parent dir if needed.
save_key_state() {
  local max_seen="${1:-0}"
  local primary="${2:-}"
  local break_glass="${3:-}"
  local applied_at
  applied_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  mkdir -p "$(dirname "$KEY_STATE_FILE")" 2>/dev/null || true

  local node_bin
  node_bin=$(_rotation_node) || {
    err "No node binary available to write $KEY_STATE_FILE"
    return 1
  }

  local tmp="${KEY_STATE_FILE}.tmp.$$"
  KEY_STATE_MAX="$max_seen" KEY_STATE_PRI="$primary" KEY_STATE_BG="$break_glass" \
  KEY_STATE_APPLIED="$applied_at" KEY_STATE_OUT="$tmp" "$node_bin" -e "
    const fs = require('fs');
    const state = {
      max_seen_sequence_number: parseInt(process.env.KEY_STATE_MAX, 10) || 0,
      primary_pubkey: process.env.KEY_STATE_PRI || null,
      break_glass_pubkey: process.env.KEY_STATE_BG || null,
      last_rotation_applied_at: process.env.KEY_STATE_APPLIED,
    };
    fs.writeFileSync(process.env.KEY_STATE_OUT, JSON.stringify(state, null, 2) + '\n');
  " || {
    rm -f "$tmp"
    err "Failed to write $KEY_STATE_FILE"
    return 1
  }
  mv -f "$tmp" "$KEY_STATE_FILE"
  chmod 600 "$KEY_STATE_FILE" 2>/dev/null || true

  KEY_STATE_MAX_SEEN="$max_seen"
  KEY_STATE_PRIMARY="$primary"
  KEY_STATE_BREAK_GLASS="$break_glass"
  KEY_STATE_LAST_APPLIED="$applied_at"
}

# _materialize_pubkey <base64-line> <dest-path>
#   Writes a minisign-format .pub file with the given base64 as the second
#   line. Used when the effective pubkey comes from state rather than a
#   shipped .pub file and we need a file path for `minisign -p`.
_materialize_pubkey() {
  local b64="$1" dest="$2"
  {
    printf 'untrusted comment: minisign public key (from key-state)\n'
    printf '%s\n' "$b64"
  } > "$dest"
  chmod 600 "$dest" 2>/dev/null || true
}

# current_primary_pubkey_file <dest-path>
#   Resolves the CURRENT trusted primary pubkey and writes it to dest-path
#   as a minisign-format .pub file. Resolution order:
#     1. KEY_STATE_PRIMARY (populated by load_key_state) — most recent rotation
#     2. $INSTALL_LINK/scripts/cidrella.pub — shipped file from the current
#        release's install.sh constant
#   Echoes the resolved path (same as dest-path) on stdout on success.
#   Returns 1 on failure (no pubkey available anywhere).
current_primary_pubkey_file() {
  local dest="${1:?dest path required}"
  if [ -n "$KEY_STATE_PRIMARY" ]; then
    _materialize_pubkey "$KEY_STATE_PRIMARY" "$dest"
    printf '%s\n' "$dest"
    return 0
  fi
  if [ -f "$INSTALL_LINK/scripts/cidrella.pub" ]; then
    cp "$INSTALL_LINK/scripts/cidrella.pub" "$dest"
    printf '%s\n' "$dest"
    return 0
  fi
  return 1
}

# current_break_glass_pubkey_file <dest-path>
#   Same as current_primary_pubkey_file but for the break-glass key.
current_break_glass_pubkey_file() {
  local dest="${1:?dest path required}"
  if [ -n "$KEY_STATE_BREAK_GLASS" ]; then
    _materialize_pubkey "$KEY_STATE_BREAK_GLASS" "$dest"
    printf '%s\n' "$dest"
    return 0
  fi
  if [ -f "$INSTALL_LINK/scripts/cidrella-break-glass.pub" ]; then
    cp "$INSTALL_LINK/scripts/cidrella-break-glass.pub" "$dest"
    printf '%s\n' "$dest"
    return 0
  fi
  return 1
}

# fetch_rotation_announcements <release-json> <out-dir>
#   Parses the release JSON (already fetched by update.sh from the GitHub
#   API), finds every asset whose name matches rotation-announcement-*.json,
#   downloads each .json + its corresponding .minisig into out-dir. Echoes
#   the base names (without path or extension) of fetched announcements on
#   stdout, one per line. Missing .minisig for an announcement is a warning,
#   not a failure — the announcement is just skipped.
fetch_rotation_announcements() {
  local release_json="$1" out_dir="$2"
  mkdir -p "$out_dir"

  local node_bin
  node_bin=$(_rotation_node) || {
    warn "No node binary for parsing release JSON — skipping rotation fetch"
    return 0
  }

  local urls
  urls=$(printf '%s' "$release_json" | "$node_bin" -e "
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(data);
        const assets = (j.assets || []).filter(a =>
          /^rotation-announcement-\d+\.json$/.test(a.name)
        );
        for (const a of assets) {
          process.stdout.write(a.browser_download_url + '\n');
        }
      } catch (e) {
        process.stderr.write('release JSON parse: ' + e.message);
      }
    });
  " 2>/dev/null) || true

  if [ -z "$urls" ]; then
    return 0
  fi

  local url name base
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    name=$(basename "$url")
    base="${name%.json}"
    # --proto '=https' + --proto-redir '=https' reject any non-HTTPS URL
    # even if a crafted release JSON tries to smuggle file://, ftp://, etc.
    # into browser_download_url. GitHub never does this, but defense in depth.
    if ! curl --proto '=https' --proto-redir '=https' -fsSL "$url" -o "$out_dir/$name" 2>/dev/null; then
      warn "Failed to download $name (continuing without it)"
      continue
    fi
    if ! curl --proto '=https' --proto-redir '=https' -fsSL "${url}.minisig" -o "$out_dir/${name}.minisig" 2>/dev/null; then
      warn "No signature file for $name — skipping (unsigned announcements are rejected)"
      rm -f "$out_dir/$name"
      continue
    fi
    printf '%s\n' "$base"
  done <<< "$urls"
}

# _parse_announcement <json-path>
#   Parses a rotation announcement JSON file. Echoes a space-separated
#   tuple: "<sequence_number> <rotation_target> <new_pubkey> <revoked_pubkey> <not_before>"
#   Returns 1 on parse error or missing required field.
_parse_announcement() {
  local json_path="$1"
  local node_bin
  node_bin=$(_rotation_node) || return 1

  JSON_PATH="$json_path" "$node_bin" -e "
    try {
      const fs = require('fs');
      const a = JSON.parse(fs.readFileSync(process.env.JSON_PATH, 'utf8'));
      if (a.type !== 'cidrella-key-rotation') throw new Error('type mismatch');
      if (!Number.isInteger(a.sequence_number)) throw new Error('sequence_number missing or not integer');
      if (!['primary', 'break-glass'].includes(a.rotation_target)) throw new Error('invalid rotation_target');
      // Minisign pubkeys are fixed-length (~56 chars, all base64) with no
      // whitespace. Reject anything outside that shape — both because
      // malformed values would shift \`read\`-based field-splitting in the
      // caller, and because a legitimate rotation announcement will never
      // contain such a value.
      const okKey = s => typeof s === 'string' && /^[A-Za-z0-9+/=]{40,128}$/.test(s);
      if (!okKey(a.new_pubkey)) throw new Error('new_pubkey missing or malformed');
      if (!okKey(a.revoked_pubkey)) throw new Error('revoked_pubkey missing or malformed');
      if (typeof a.not_before !== 'string') throw new Error('not_before missing');
      process.stdout.write([
        a.sequence_number,
        a.rotation_target,
        a.new_pubkey,
        a.revoked_pubkey,
        a.not_before,
      ].join(' '));
    } catch (e) {
      process.stderr.write('announcement parse: ' + e.message);
      process.exit(1);
    }
  " 2>/dev/null
}

# apply_rotation_announcements <fetch-dir> <break-glass-pubkey-file>
#   For each rotation-announcement-*.json + .minisig in fetch-dir:
#     - Verify the signature against <break-glass-pubkey-file>
#     - Parse the announcement
#     - Reject if sequence_number <= KEY_STATE_MAX_SEEN
#     - Reject if not_before is in the future
#     - Reject if revoked_pubkey doesn't match the current trusted key of
#       the appropriate type
#     - Apply: update KEY_STATE_* in-memory (persist happens after loop)
#     - Emit events throughout
#   Returns 0 if all processed cleanly (whether or not any were applied);
#   returns 1 only if a signed announcement failed to verify (tamper signal).
#
#   Announcements are applied in sequence_number ascending order, so a
#   chain of multiple rotations in one release is handled correctly.
apply_rotation_announcements() {
  local fetch_dir="$1" bg_pub_file="$2"
  shopt -s nullglob
  local files=( "$fetch_dir"/rotation-announcement-*.json )
  shopt -u nullglob

  if [ "${#files[@]}" -eq 0 ]; then
    return 0
  fi

  # Build a sortable list: "<seq> <path>" lines, sort numerically
  local sorted entry json seq target new_pk revoked_pk not_before now
  sorted=""
  for json in "${files[@]}"; do
    entry=$(_parse_announcement "$json") || {
      warn "Failed to parse $(basename "$json") — skipping"
      continue
    }
    seq="${entry%% *}"
    sorted+="$seq $json"$'\n'
  done

  # Sort by sequence ascending; remove trailing empty line
  sorted=$(printf '%s' "$sorted" | sort -n | sed '/^$/d')

  local max_seen="${KEY_STATE_MAX_SEEN:-0}"
  local primary="$KEY_STATE_PRIMARY"
  local break_glass="$KEY_STATE_BREAK_GLASS"
  local shipped_primary="$INSTALL_LINK/scripts/cidrella.pub"
  local shipped_bg="$INSTALL_LINK/scripts/cidrella-break-glass.pub"

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    json=$(echo "$line" | cut -d' ' -f2-)
    local name
    name=$(basename "$json" .json)

    entry=$(_parse_announcement "$json") || continue
    read -r seq target new_pk revoked_pk not_before <<< "$entry"

    # Replay protection
    if [ "$seq" -le "$max_seen" ] 2>/dev/null; then
      info "$name: sequence $seq <= max_seen $max_seen — already applied, skipping"
      continue
    fi

    # Verify signature against break-glass pubkey
    if ! verify_minisign "$json" "${json}.minisig" "$bg_pub_file"; then
      err "$name: signature verification failed"
      emit_event rotation fail "announcement=$name" reason=bad-signature
      return 1
    fi

    # not_before check (coarse — string compare works for ISO8601 UTC)
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$not_before" \> "$now" ]; then
      info "$name: not_before=$not_before is in the future — deferring"
      continue
    fi

    # Revoked-pubkey sanity check: the announcement claims to be retiring
    # a specific pubkey. That pubkey must match whatever we currently trust
    # for the given rotation_target. Otherwise the announcement was written
    # for a different install or an attacker is replaying against a state
    # we've already moved past.
    local current_for_target=""
    case "$target" in
      primary)
        current_for_target="$primary"
        if [ -z "$current_for_target" ] && [ -f "$shipped_primary" ]; then
          current_for_target=$(sed -n '2p' "$shipped_primary" | tr -d '[:space:]')
        fi
        ;;
      break-glass)
        current_for_target="$break_glass"
        if [ -z "$current_for_target" ] && [ -f "$shipped_bg" ]; then
          current_for_target=$(sed -n '2p' "$shipped_bg" | tr -d '[:space:]')
        fi
        ;;
    esac

    if [ "$current_for_target" != "$revoked_pk" ]; then
      warn "$name: revoked_pubkey in announcement does not match currently-trusted $target key"
      warn "  announcement claims to retire: $revoked_pk"
      warn "  current trusted $target key:   $current_for_target"
      warn "  Rejecting as stale/mismatched — investigate before manually applying."
      emit_event rotation fail "announcement=$name" reason=revoked-mismatch
      continue
    fi

    # Apply
    case "$target" in
      primary)
        primary="$new_pk"
        ok "$name: primary pubkey rotated (seq=$seq)"
        emit_event rotation pass "announcement=$name" "target=primary" "seq=$seq"
        ;;
      break-glass)
        break_glass="$new_pk"
        ok "$name: break-glass pubkey rotated (seq=$seq)"
        emit_event rotation pass "announcement=$name" "target=break-glass" "seq=$seq"
        ;;
    esac
    max_seen="$seq"
  done <<< "$sorted"

  # Persist updated state (only if anything changed)
  if [ "$max_seen" != "${KEY_STATE_MAX_SEEN:-0}" ]; then
    save_key_state "$max_seen" "$primary" "$break_glass"
    ok "Key state persisted: max_seen=$max_seen"
  fi
  return 0
}
