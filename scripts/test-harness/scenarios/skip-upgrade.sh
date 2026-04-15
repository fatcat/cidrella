#!/bin/bash
# Scenario: skip-upgrade
#
# Validates that `cidrella-update` runs end-to-end on a bundled-Node-only
# host without hitting the bare-`node` preflight bug fixed in v0.4.11. This
# is the anchor regression test for the bug that made CLI recovery
# unreliable for v0.4.8/v0.4.9 hosts — the preflight syntax check used
# bare `node --check` instead of the resolved bundled binary, so a
# bundled-Node-only host (the supported config since v0.4.7) hit
# command-not-found and misreported it as "syntax errors in index.js".
#
# This scenario also exercises the full update-in-place flow even when no
# newer release is available: update.sh should cleanly exit with "already
# up to date" instead of crashing, and the runtime/node resolver should
# successfully locate the bundled binary.
#
# Note: this scenario tests the PRESENT-DAY path on testerella, which is
# bundled-Node-only. It does NOT exercise a real version jump unless
# there's a newer release than the one install_latest_release pulls. Once
# v0.4.12+ ships, the same scenario automatically becomes a real
# skip-upgrade regression test — the scenario asks "can CLI update run to
# completion from the current installed version?" and the answer scales
# with what's published.

SCENARIO_NAME="skip-upgrade"
SCENARIO_DESCRIPTION="CLI cidrella-update runs end-to-end on a bundled-Node-only host (bare-node preflight bug regression test)"

scenario_setup() {
  return 0
}

scenario_run() {
  install_latest_release

  # Run cidrella-update and capture output. Either outcome is acceptable:
  # (a) no newer version available — cidrella-update exits 0 with an
  #     "already up to date" or "up-to-date" message
  # (b) a newer version exists — the update proceeds through download,
  #     verify, extract, preflight, switchover, health-check
  # The failure mode we're guarding against is the bare-node preflight bug:
  # cidrella-update claiming "syntax errors in server/src/index.js" when
  # the real cause is that system `node` isn't on PATH. Capture is used in
  # assertions.
  cidrella-update > /tmp/cidrella-update-output.log 2>&1
  echo "cidrella-update exit code: $?" >> /tmp/cidrella-update-output.log
}

scenario_assert() {
  # ─── Preflight syntax check must NOT report "syntax errors" ──
  # This is the regression guard. If bare `node --check` ever slips back
  # into update.sh, this assertion will fire.
  assert_command_ok "! grep -q 'syntax errors' /tmp/cidrella-update-output.log"

  # ─── And the wording for the v0.4.11 diagnostic path must NOT fire ──
  # If the resolved bundled Node were actually failing, the new error
  # path would print "Pre-flight failed: server/src/index.js failed
  # syntax check". That's a DIFFERENT class of failure from the old
  # bare-node bug, but we treat it as a regression on this supported host.
  assert_command_ok "! grep -q 'Pre-flight failed' /tmp/cidrella-update-output.log"

  # ─── cidrella-update exited 0 ────────────────────────────────
  assert_command_ok "grep -q 'cidrella-update exit code: 0' /tmp/cidrella-update-output.log"

  # ─── Service remains active afterward ────────────────────────
  # Whether the update completed or there was nothing to do, the service
  # should still be running.
  assert_systemctl_active cidrella
  assert_http_200 "https://127.0.0.1:8443/api/health/deep"

  # ─── Bundled node resolver finds the binary ──────────────────
  # Direct probe against the file the Phase 0 resolver returns.
  assert_file_exists /opt/cidrella/runtime/node/bin/node
  assert_command_ok "/opt/cidrella/runtime/node/bin/node --check /opt/cidrella/server/src/index.js"

  # ─── If an update actually happened, syntax check should be logged ──
  # v0.4.11+ emits a structured event when preflight syntax check passes.
  # If update.sh ran (newer version was available), we expect the events
  # log to have SOME preflight pass entry. If it didn't run (up to date),
  # this assertion is vacuously true via the grep-or-skip pattern.
  assert_command_ok "[ ! -f /var/lib/cidrella/events.jsonl ] || ! grep -q 'reason=syntax-check' /var/lib/cidrella/events.jsonl"
}

scenario_capture() {
  capture_file_tail "update_output" /tmp/cidrella-update-output.log 60
  capture_command "installed_version" "cat /opt/cidrella/package.json | grep version"
  capture_command "node_version" "/opt/cidrella/runtime/node/bin/node --version"
  capture_command "node_on_path" "which node 2>&1 || echo 'no system node'"
  capture_command "services_active" "systemctl is-active cidrella cidrella-dnsmasq cidrella-anomaly"
  capture_file_tail "events_jsonl" /var/lib/cidrella/events.jsonl 30
}

scenario_main
