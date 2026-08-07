#!/bin/bash
# Scenario: fresh-install
#
# Validates that a fresh install of the latest CIDRella release lands cleanly:
# all three services come up, the deep-health endpoint returns ok for every
# subsystem, and the release-specific artifacts that should be on disk
# actually are. This is the baseline scenario every future feature should
# either extend or keep passing.

SCENARIO_NAME="fresh-install"
SCENARIO_DESCRIPTION="Fresh install of the latest release + full post-install state verification"

scenario_setup() {
  # No setup, the runner wipes the host before this scenario runs.
  return 0
}

scenario_run() {
  # Download install.sh from main and run it non-interactively. `yes y`
  # feeds past the one interactive prompt (systemd-resolved stub disable
  # on clean testerella). We redirect output to a log the capture phase
  # picks up.
  install_latest_release
}

scenario_assert() {
  # ─── Version + health ─────────────────────────────────
  assert_http_200 "https://127.0.0.1:8443/api/health"
  assert_http_200 "https://127.0.0.1:8443/api/health/deep"
  assert_json_field "https://127.0.0.1:8443/api/health/deep" "status" "ok"
  assert_json_field "https://127.0.0.1:8443/api/health/deep" "checks.sqlite.ok" "true"
  assert_json_field "https://127.0.0.1:8443/api/health/deep" "checks.duckdb.ok" "true"
  assert_json_field "https://127.0.0.1:8443/api/health/deep" "checks.bcrypt.ok" "true"
  assert_json_field "https://127.0.0.1:8443/api/health/deep" "checks.ping.ok" "true"

  # ─── All three services active ────────────────────────
  assert_systemctl_active cidrella
  assert_systemctl_active cidrella-dnsmasq
  assert_systemctl_active cidrella-anomaly

  # ─── Wrappers installed (v0.4.6+/0.4.8+) ──────────────
  assert_file_exists /usr/local/bin/cidrella-node
  assert_file_exists /usr/local/bin/cidrella-dnsmasq-hup
  assert_file_exists /usr/local/bin/cidrella-rollback
  assert_file_exists /usr/local/bin/cidrella-update
  assert_file_exists /usr/local/bin/cidrella-reset-password
  assert_file_mode /usr/local/bin/cidrella-reset-password 700
  assert_file_owner /usr/local/bin/cidrella-reset-password root

  # ─── v0.4.9+ post-install hook scaffolding ────────────
  assert_file_exists /opt/cidrella/scripts/post-install.sh
  assert_file_exists /opt/cidrella/scripts/lib/rotation.sh
  assert_file_exists /opt/cidrella/scripts/cidrella-break-glass.pub
  assert_file_exists /opt/cidrella/scripts/cidrella.pub

  # ─── Shared lib files (v0.4.4+/0.4.8+) ────────────────
  assert_file_exists /opt/cidrella/scripts/lib/log.sh
  assert_file_exists /opt/cidrella/scripts/lib/verify.sh
  assert_file_exists /opt/cidrella/scripts/lib/slots.sh
  assert_file_exists /opt/cidrella/scripts/lib/systemd-install.sh
  assert_file_exists /opt/cidrella/scripts/lib/tighten-secrets.sh

  # ─── Bundled Node runtime (v0.4.7+) ───────────────────
  assert_file_exists /opt/cidrella/runtime/node/bin/node
  # Derive the expected runtime from the release the host actually installed,
  # rather than restating it here. This asserted '^v22' against builds that have
  # bundled Node 24 since v0.4.16, so it was permanently red and trained readers
  # to skip it. See REVIEW.md, duplicate-logic audit #36.
  assert_command_ok "test \"v\$(grep -oE '\"bundled_node_version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"' /opt/cidrella/RELEASE.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')\" = \"\$(/opt/cidrella/runtime/node/bin/node --version)\""

  # ─── Events log has the expected install phases ───────
  assert_file_exists /var/lib/cidrella/events.jsonl
  assert_file_contains /var/lib/cidrella/events.jsonl "install"
  assert_file_contains /var/lib/cidrella/events.jsonl "extract"
  assert_file_contains /var/lib/cidrella/events.jsonl "systemd"
}

scenario_capture() {
  capture_command "api_health" "curl -sk https://127.0.0.1:8443/api/health"
  capture_command "api_health_deep" "curl -sk https://127.0.0.1:8443/api/health/deep"
  capture_command "services_active" "systemctl is-active cidrella cidrella-dnsmasq cidrella-anomaly"
  capture_command "wrappers_installed" "ls -la /usr/local/bin/cidrella-* 2>&1"
  capture_command "slot_scripts" "ls /opt/cidrella/scripts/"
  capture_command "slot_lib" "ls /opt/cidrella/scripts/lib/"
  capture_file_tail "events_jsonl" /var/lib/cidrella/events.jsonl 20
  capture_command "release_json" "cat /opt/cidrella/RELEASE.json 2>/dev/null || echo missing"
  capture_file_tail "install_output" /tmp/install-output.log 40
}

scenario_main
