#!/bin/bash
# Scenario: upgrade-path
#
# The real old→new update jump: install a pinned previous release
# (FROM_TAG, default v0.4.15), then run cidrella-update to a PUBLISHED
# candidate (pre-)release (CANDIDATE_VERSION, required, e.g. 0.4.16-pre.1)
# and assert the full A/B switchover: update-status success, active slot
# changed, deep health, schema version, services up, switchover events.
#
# Why the candidate must be a published GitHub (pre-)release rather than an
# scp'd local tarball: update.sh has no local-file input at all, and the
# updater that performs this jump is the INSTALLED old release's updater,
# it would not have any new flag we might add. Going through the published
# tag exercises the true production pipeline: releases-API resolution →
# download → minisign verify → RELEASE.json → min_from gate → self-bootstrap
# handoff into the candidate's own updater. (An scp'd-tarball mode was
# considered and rejected for exactly this reason.)
#
# This scenario catches: updater regressions in the shipped FROM release,
# self-bootstrap handoff breakage, min_from misconfiguration in the
# candidate's RELEASE.json, migration failures on real upgrade, and
# slot-switch plumbing. It needs CANDIDATE_VERSION set, run via:
#   ./run.sh --scenario upgrade-path --candidate 0.4.16-pre.1 [--from-tag v0.4.15]

SCENARIO_NAME="upgrade-path"
SCENARIO_DESCRIPTION="Pinned install of FROM_TAG then cidrella-update to CANDIDATE_VERSION; asserts slot switchover, deep health, schema, events"

# Schema version the candidate is expected to land on. Bump alongside new
# migrations (max migration number, 048 intentionally skipped).
EXPECTED_SCHEMA="${EXPECTED_SCHEMA:-50}"

# The web port depends on install-time probing: a fresh install grabs 443
# when it's free, else 8443. Probe both and remember the answer.
cidrella_base_url() {
  if [ -f /tmp/cidrella-base-url ]; then cat /tmp/cidrella-base-url; return; fi
  local url
  for url in "https://127.0.0.1:8443" "https://127.0.0.1"; do
    if curl -skf --max-time 3 "$url/api/health" >/dev/null 2>&1; then
      echo "$url" | tee /tmp/cidrella-base-url
      return
    fi
  done
  echo "https://127.0.0.1:8443"
}

scenario_setup() {
  if [ -z "$CANDIDATE_VERSION" ]; then
    echo "upgrade-path: CANDIDATE_VERSION is required (pass --candidate to run.sh)" >&2
    return 1
  fi
  install_release_tag "$FROM_TAG" || return 1

  # Remember the active slot immediately (before any wait that could time
  # out) so the assert phase can prove it switched.
  readlink -f /opt/cidrella > /tmp/slot-before.txt

  # Wait for the FROM release to come up healthy before updating from it,
  # otherwise update failures are indistinguishable from a bad baseline.
  local tries=0
  rm -f /tmp/cidrella-base-url
  until curl -skf "$(cidrella_base_url)/api/health" >/dev/null 2>&1; do
    rm -f /tmp/cidrella-base-url
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && { echo "FROM release never became healthy" >&2; return 1; }
    sleep 2
  done
}

scenario_run() {
  cidrella-update --version "$CANDIDATE_VERSION" > /tmp/cidrella-update-output.log 2>&1
  echo "cidrella-update exit code: $?" >> /tmp/cidrella-update-output.log
  readlink -f /opt/cidrella > /tmp/slot-after.txt
  # The web port can differ across versions; re-probe for the asserts.
  rm -f /tmp/cidrella-base-url
}

scenario_assert() {
  local base
  base=$(cidrella_base_url)

  # ─── Updater completed (CLI mode writes no update-status.json; the
  # events log is the durable record) ───────────────────
  assert_command_ok "grep -q 'cidrella-update exit code: 0' /tmp/cidrella-update-output.log"
  assert_command_ok "grep -q '\"phase\":\"update\",\"event\":\"end\".*\"result\":\"success\"' /var/lib/cidrella/events.jsonl"
  assert_command_ok "grep -q '\"phase\":\"health\",\"event\":\"pass\".*${CANDIDATE_VERSION}' /var/lib/cidrella/events.jsonl"

  # ─── A/B slot actually switched (both snapshots must exist) ──
  assert_command_ok "[ -s /tmp/slot-before.txt ] && [ -s /tmp/slot-after.txt ] && ! diff -q /tmp/slot-before.txt /tmp/slot-after.txt"

  # ─── Candidate version is what's running ──────────────
  assert_command_ok "grep -q '\"version\": \"${CANDIDATE_VERSION%%-*}' /opt/cidrella/package.json"

  # ─── Deep health on the new slot (port probed, not assumed) ──
  assert_http_200 "$base/api/health/deep"
  assert_json_field "$base/api/health/deep" "status" "ok"
  assert_json_field "$base/api/health/deep" "checks.sqlite.ok" "true"
  assert_json_field "$base/api/health/deep" "checks.duckdb.ok" "true"

  # ─── Schema migrated (bundled node + better-sqlite3; the host has no
  # sqlite3 CLI and it is not a CIDRella dependency) ────
  assert_command_ok "cd /opt/cidrella/server && [ \"\$(/opt/cidrella/runtime/node/bin/node -e \"console.log(require('better-sqlite3')('/var/lib/cidrella/cidrella.db',{readonly:true}).prepare('SELECT MAX(version) v FROM schema_version').get().v)\")\" = \"$EXPECTED_SCHEMA\" ]"

  # ─── Services up, switchover recorded ─────────────────
  assert_systemctl_active cidrella
  assert_systemctl_active cidrella-dnsmasq
  assert_file_contains /var/lib/cidrella/events.jsonl "switchover"
}

scenario_capture() {
  capture_file_tail "install_output" /tmp/install-output.log 40
  capture_file_tail "update_output" /tmp/cidrella-update-output.log 80
  capture_command "slot_before_after" "cat /tmp/slot-before.txt /tmp/slot-after.txt"
  capture_command "installed_version" "grep version /opt/cidrella/package.json"
  capture_file_tail "update_status" /var/lib/cidrella/update-status.json 20
  capture_file_tail "events_jsonl" /var/lib/cidrella/events.jsonl 40
  capture_command "deep_health" "curl -sk https://127.0.0.1:8443/api/health/deep"
  capture_command "schema_version" "sqlite3 /var/lib/cidrella/cidrella.db 'SELECT MAX(version) FROM schema_version' 2>&1"
}

scenario_main
