#!/usr/bin/env bash
# Differential check: the two resolve_node implementations must agree.
#
# scripts/lib/slots.sh has the canonical one. scripts/rollback.sh carries a
# deliberate copy, because rollback must keep working even when the installation
# it is repairing (and /usr/local/bin/cidrella-node with it) has been wiped, so
# it sources nothing. That is a documented reason to duplicate, and the price of
# keeping a duplicate is a test that fails when the two drift.
#
# They used to disagree completely: one checked only slot runtimes and then
# printed a hardcoded /usr/bin/node WITHOUT testing it, the other checked only
# the wrapper and PATH. Neither could resolve a host the other could, and the
# first could not tell "found" from "guessed".
# See REVIEW.md, duplicate-logic audit #33.
#
# Runs standalone, no appliance required. Exit 0 if they agree.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
BASH_ABS="$(command -v bash)"

# Extract each implementation into its own file so they can be sourced without
# their surrounding script running.
extract() {
  awk '/^resolve_node\(\) \{/,/^\}/' "$1"
}
extract "$ROOT/scripts/lib/slots.sh"   > "$TMP/lib.sh"
extract "$ROOT/scripts/rollback.sh"    > "$TMP/rb.sh"

for f in lib rb; do
  if ! grep -q 'resolve_node()' "$TMP/$f.sh"; then
    echo "ERROR: could not extract resolve_node from $f (did the function shape change?)"
    exit 2
  fi
done

# The wrapper branch is an absolute path that does not exist on a dev machine,
# so behavioral cases alone cannot see it: changing it in one copy to another
# non-existent path is indistinguishable. Two separate checks close that.
#
# 1. Textual: the literal candidate lists must match. This catches a drift in
#    the wrapper path itself, which no runtime case on this host can.
if ! diff <(grep -oE '"/[^"]+"' "$TMP/lib.sh") <(grep -oE '"/[^"]+"' "$TMP/rb.sh") >/dev/null; then
  echo "  DIFF  hardcoded candidate paths differ between the two copies"
  diff <(grep -oE '"/[^"]+"' "$TMP/lib.sh") <(grep -oE '"/[^"]+"' "$TMP/rb.sh") | sed 's/^/        /'
  fail=1
else
  echo "  ok    hardcoded candidate paths are identical"
fi

# 2. Behavioral: rewrite the wrapper path to a temp file in BOTH copies
#    identically, so the branch can actually be exercised.
mkdir -p "$TMP/wrapdir"
printf '#!/bin/sh\necho vwrap\n' > "$TMP/wrapdir/cidrella-node"
chmod +x "$TMP/wrapdir/cidrella-node"
sed -i "s#/usr/local/bin/cidrella-node#$TMP/wrapdir/cidrella-node#" "$TMP/lib.sh" "$TMP/rb.sh"

# A second pair with the wrapper pointed somewhere that does not exist, so the
# "found nothing, return 1" path can be reached. Without these, every case
# resolved to the wrapper at rc=0 and the failure return was never exercised
# by anything, on either side. That return is load-bearing: update.sh now does
# `if ! PREFLIGHT_NODE=$(resolve_node ...)` and aborts with a named error, which
# only works if resolve_node genuinely reports failure instead of guessing.
cp "$TMP/lib.sh" "$TMP/lib-nowrap.sh"
cp "$TMP/rb.sh"  "$TMP/rb-nowrap.sh"
sed -i "s#$TMP/wrapdir/cidrella-node#$TMP/absent/cidrella-node#" "$TMP/lib-nowrap.sh" "$TMP/rb-nowrap.sh"

# Each case: a description, the slot argument, an optional PATH override, and
# an optional variant suffix selecting which extracted pair to source.
run_case() {
  local desc="$1" slot="$2" extra_path="${3:-}" variant="${4:-}"
  local a b ra rb
  # BASH_ABS, not "bash": overriding PATH hides bash itself, and both sides then
  # fail at rc=127 identically, which this script would score as agreement. That
  # false pass is exactly what a differential test must not do. resolve_node uses
  # only builtins plus `command`, so an otherwise-empty PATH is fine.
  a=$(PATH="${extra_path:-$PATH}" "$BASH_ABS" -c "source '$TMP/lib${variant}.sh'; resolve_node '$slot' 2>/dev/null"); ra=$?
  b=$(PATH="${extra_path:-$PATH}" "$BASH_ABS" -c "source '$TMP/rb${variant}.sh';  resolve_node '$slot' 2>/dev/null"); rb=$?
  if [ "$a" = "$b" ] && [ "$ra" = "$rb" ]; then
    printf '  ok    %-46s -> %s (rc=%s)\n' "$desc" "${a:-<none>}" "$ra"
  else
    printf '  DIFF  %-46s\n        lib: %s (rc=%s)\n        rb : %s (rc=%s)\n' \
      "$desc" "${a:-<none>}" "$ra" "${b:-<none>}" "$rb"
    fail=1
  fi
}

# A fake slot with a bundled runtime, which is the case that matters during an
# A/B update and that the old wrapper-first family could not see at all.
mkdir -p "$TMP/slot/runtime/node/bin"
printf '#!/bin/sh\necho v0\n' > "$TMP/slot/runtime/node/bin/node"
chmod +x "$TMP/slot/runtime/node/bin/node"

echo "resolve_node differential (lib/slots.sh vs rollback.sh)"
run_case "slot with a bundled runtime"        "$TMP/slot"
run_case "no slot argument"                   ""
run_case "slot that does not exist"           "$TMP/nope"
mkdir -p "$TMP/emptybin"
run_case "slot present, PATH stripped of node" "$TMP/slot" "$TMP/emptybin"
# Exercises the wrapper branch: no slot, no /opt install, no node on PATH.
run_case "wrapper is the only candidate"      ""          "$TMP/emptybin"
# The failure path, using the no-wrapper pair. Both must return 1 and print
# nothing. A copy that falls back to guessing a path shows up here as a diff.
run_case "nothing available anywhere"         ""          "$TMP/emptybin" "-nowrap"

# The rc=1 contract is the reason the guessing fallback was removed, so assert
# it outright rather than only checking that the two copies agree: they could
# agree on the wrong answer.
for v in lib rb; do
  out=$(PATH="$TMP/emptybin" "$BASH_ABS" -c "source '$TMP/$v-nowrap.sh'; resolve_node '' 2>/dev/null"); rc=$?
  if [ "$rc" -eq 1 ] && [ -z "$out" ]; then
    printf '  ok    %-46s -> rc=1, no output\n' "$v returns failure when nothing exists"
  else
    printf '  FAIL  %-46s -> printed %s (rc=%s), expected rc=1 and no output\n' \
      "$v returns failure when nothing exists" "${out:-<none>}" "$rc"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "resolve_node differential: OK (implementations agree)"
else
  echo "resolve_node differential: FAILED."
  echo "A DIFF line means the two copies have drifted: fix both, or collapse them"
  echo "if rollback.sh no longer needs to be standalone."
  echo "A FAIL line means a copy broke the rc=1 contract, which both can do while"
  echo "still agreeing with each other. update.sh depends on that return."
fi
exit "$fail"
