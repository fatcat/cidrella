#!/bin/bash
# Scenario: min-from-blocked
#
# Validates the v0.4.12+ min_from gate in update.sh: a signed RELEASE.json
# with a min_from field that's newer than the running version must refuse
# the install with a diagnostic-sufficient error and emit a structured
# event. Without this gate, a user on an old enough version could silently
# install a release whose schema migrations or post-install hooks assume
# an intermediate was already landed.
#
# This scenario uses a unit-style approach because creating a real
# end-to-end test requires a signed release tarball with a doctored
# RELEASE.json, a fixture we don't currently commit to the repo. Instead
# we: (a) install the latest release normally, (b) write a synthetic
# RELEASE.json to a temp location, (c) directly exercise the gate's
# parsing + comparison logic the same way update.sh does it, and (d)
# assert the decision matches expectations for each case.
#
# The happy path (min_from satisfied) and the refuse path (min_from
# unmet) are both covered. If either regresses, the assertions fire.

SCENARIO_NAME="min-from-blocked"
SCENARIO_DESCRIPTION="min_from gate in update.sh refuses installs when the running version is below the required intermediate"

scenario_setup() {
  return 0
}

scenario_run() {
  install_latest_release

  # Write synthetic RELEASE.json files for the unit test. The gate's sed
  # pattern matches exactly `"min_from"\s*:\s*"..."`, so these cover:
  #   1. min_from satisfied (running ≥ required): gate MUST pass
  #   2. min_from unmet (running < required):     gate MUST refuse
  #   3. min_from null/absent:                    gate MUST skip (no gate)

  mkdir -p /tmp/min-from-test

  cat > /tmp/min-from-test/case1-satisfied.json <<'JSON'
{
  "version": "0.9.0",
  "built_at": "2026-01-01T00:00:00Z",
  "commit_sha": "deadbeef",
  "bundled_node_version": "22.22.2",
  "min_from": "0.4.0"
}
JSON

  cat > /tmp/min-from-test/case2-unmet.json <<'JSON'
{
  "version": "0.9.0",
  "built_at": "2026-01-01T00:00:00Z",
  "commit_sha": "deadbeef",
  "bundled_node_version": "22.22.2",
  "min_from": "9.9.9"
}
JSON

  cat > /tmp/min-from-test/case3-null.json <<'JSON'
{
  "version": "0.9.0",
  "built_at": "2026-01-01T00:00:00Z",
  "commit_sha": "deadbeef",
  "bundled_node_version": "22.22.2",
  "min_from": null
}
JSON

  cat > /tmp/min-from-test/case4-absent.json <<'JSON'
{
  "version": "0.9.0",
  "built_at": "2026-01-01T00:00:00Z",
  "commit_sha": "deadbeef",
  "bundled_node_version": "22.22.2"
}
JSON

  # Now reproduce the exact gate logic from update.sh. Source the shared
  # slots.sh lib that provides semver_lt (the same comparator update.sh
  # uses), then run the extraction + comparison for each case. We write
  # the outcome to a results file the assertion phase reads.
  cat > /tmp/min-from-test/gate-probe.sh <<'PROBE'
#!/bin/bash
# Mirrors the update.sh v0.4.12 min_from gate exactly.
set -u
source /opt/cidrella/scripts/lib/slots.sh 2>/dev/null || exit 90

probe_gate() {
  local release_meta="$1"
  local current_version="$2"
  local MIN_FROM
  MIN_FROM=$(sed -n 's/.*"min_from"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$release_meta" | head -1)
  if [ -n "$MIN_FROM" ] && [ "$current_version" != "unknown" ] && semver_lt "$current_version" "$MIN_FROM"; then
    echo "REFUSED min_from=$MIN_FROM current=$current_version"
    return 1
  fi
  echo "ALLOWED min_from=${MIN_FROM:-<none>} current=$current_version"
  return 0
}

# Case 1: satisfied (current 0.4.11 >= required 0.4.0)
RESULT=$(probe_gate /tmp/min-from-test/case1-satisfied.json 0.4.11); RC=$?
echo "case1: $RESULT rc=$RC" > /tmp/min-from-test/results.txt

# Case 2: unmet (current 0.4.11 < required 9.9.9)
RESULT=$(probe_gate /tmp/min-from-test/case2-unmet.json 0.4.11); RC=$?
echo "case2: $RESULT rc=$RC" >> /tmp/min-from-test/results.txt

# Case 3: min_from null (JSON null, sed doesn't match)
RESULT=$(probe_gate /tmp/min-from-test/case3-null.json 0.4.11); RC=$?
echo "case3: $RESULT rc=$RC" >> /tmp/min-from-test/results.txt

# Case 4: min_from field absent entirely
RESULT=$(probe_gate /tmp/min-from-test/case4-absent.json 0.4.11); RC=$?
echo "case4: $RESULT rc=$RC" >> /tmp/min-from-test/results.txt

# Case 5: unknown current version (pre-v0.4.3 no-RELEASE.json fallback)
RESULT=$(probe_gate /tmp/min-from-test/case2-unmet.json unknown); RC=$?
echo "case5: $RESULT rc=$RC" >> /tmp/min-from-test/results.txt
PROBE

  chmod +x /tmp/min-from-test/gate-probe.sh
  bash /tmp/min-from-test/gate-probe.sh
}

scenario_assert() {
  # ─── Source file exists (slots.sh is where semver_lt lives) ──
  assert_file_exists /opt/cidrella/scripts/lib/slots.sh

  # ─── Results file produced ──
  assert_file_exists /tmp/min-from-test/results.txt

  # ─── Case 1: satisfied → ALLOWED, rc=0 ──
  assert_file_contains /tmp/min-from-test/results.txt "case1: ALLOWED min_from=0.4.0 current=0.4.11"
  assert_file_contains /tmp/min-from-test/results.txt "case1:"
  # spot-check exit code
  assert_command_ok "grep -q 'case1:.*rc=0' /tmp/min-from-test/results.txt"

  # ─── Case 2: unmet → REFUSED, rc=1 ──
  assert_file_contains /tmp/min-from-test/results.txt "case2: REFUSED min_from=9.9.9 current=0.4.11"
  assert_command_ok "grep -q 'case2:.*rc=1' /tmp/min-from-test/results.txt"

  # ─── Case 3: JSON null → no gate, ALLOWED ──
  assert_file_contains /tmp/min-from-test/results.txt "case3: ALLOWED min_from=<none>"
  assert_command_ok "grep -q 'case3:.*rc=0' /tmp/min-from-test/results.txt"

  # ─── Case 4: field absent → no gate, ALLOWED ──
  assert_file_contains /tmp/min-from-test/results.txt "case4: ALLOWED min_from=<none>"
  assert_command_ok "grep -q 'case4:.*rc=0' /tmp/min-from-test/results.txt"

  # ─── Case 5: unknown current → gate SKIPS (not blocked) ──
  # Pre-v0.4.3 releases had no RELEASE.json at all, so update.sh sets
  # CURRENT_VERSION=unknown. The gate must not block in that case.
  assert_file_contains /tmp/min-from-test/results.txt "case5: ALLOWED min_from=9.9.9 current=unknown"
  assert_command_ok "grep -q 'case5:.*rc=0' /tmp/min-from-test/results.txt"

  # ─── The real update.sh in the installed slot contains the gate code ──
  # Regression guard: if a future refactor removes the gate, this scenario
  # would silently stop testing anything useful. Make sure the gate's sed
  # pattern and semver_lt invocation actually exist in the shipped update.sh.
  assert_file_contains /opt/cidrella/update.sh 'min_from'
  assert_file_contains /opt/cidrella/update.sh 'reason=min_from_unmet'
  assert_file_contains /opt/cidrella/update.sh 'semver_lt "$CURRENT_VERSION" "$MIN_FROM"'
}

scenario_capture() {
  capture_file "results" /tmp/min-from-test/results.txt
  capture_command "slots_semver_functions" "grep -n 'semver_lt\\|semver_gt\\|semver_eq' /opt/cidrella/scripts/lib/slots.sh"
  capture_command "update_sh_gate" "grep -n -A4 'min_from gate' /opt/cidrella/update.sh 2>&1 | head -40"
  capture_file "case1_json" /tmp/min-from-test/case1-satisfied.json
  capture_file "case2_json" /tmp/min-from-test/case2-unmet.json
}

scenario_main
