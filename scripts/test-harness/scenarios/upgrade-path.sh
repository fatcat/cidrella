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

# Schema version the candidate is expected to land on: the highest migration
# number the INSTALLED release ships, read off the target after the update.
#
# Two earlier versions of this were both wrong. A hardcoded 50 went stale on
# every schema change. Replacing it with a `dirname "${BASH_SOURCE[0]}"` lookup
# of this checkout's migrations directory was worse, because it was dead code:
# the runner pipes this scenario to the host through `bash -s`, so BASH_SOURCE
# is unset, dirname yields ".", the ls fails and it fell through to 50 anyway.
# The number it WOULD have produced was also the wrong one, since upgrade-path
# tests a published candidate while the checkout is normally ahead of it.
#
# Deriving it from the installed slot is not circular. It asserts that every
# migration the release shipped actually ran: a migration that failed or was
# skipped leaves the DB below the file count, which is the bug this catches.
# Override with EXPECTED_SCHEMA= to pin an exact number.
# See REVIEW.md, duplicate-logic audit #36.
shipped_schema() {
  ls /opt/cidrella/server/src/db/migrations 2>/dev/null \
    | grep -oE '^[0-9]+' | sort -n | tail -1 | sed 's/^0*//'
}

# cidrella_base_url now lives in lib/scenario-lib.sh (audit #35).

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
  local expect_schema="${EXPECTED_SCHEMA:-$(shipped_schema)}"
  # An empty expectation would make the comparison below vacuous, so say so
  # rather than reporting a pass nobody checked.
  assert_command_ok "[ -n '$expect_schema' ]"
  assert_command_ok "cd /opt/cidrella/server && [ \"\$(/opt/cidrella/runtime/node/bin/node -e \"console.log(require('better-sqlite3')('/var/lib/cidrella/cidrella.db',{readonly:true}).prepare('SELECT MAX(version) v FROM schema_version').get().v)\")\" = \"$expect_schema\" ]"

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
  capture_command "deep_health" "curl -sk $(cidrella_base_url)/api/health/deep"
  # Bundled node, not sqlite3: the host has no sqlite3 CLI, so the old capture
  # recorded "command not found" on every run instead of the schema version,
  # which is the one number you want when the schema assert fails.
  capture_command "schema_version" "cd /opt/cidrella/server && /opt/cidrella/runtime/node/bin/node -e \"console.log(require('better-sqlite3')('/var/lib/cidrella/cidrella.db',{readonly:true}).prepare('SELECT MAX(version) v FROM schema_version').get().v)\" 2>&1"
  capture_command "shipped_migrations" "ls /opt/cidrella/server/src/db/migrations 2>&1 | tail -5"
}

scenario_main
