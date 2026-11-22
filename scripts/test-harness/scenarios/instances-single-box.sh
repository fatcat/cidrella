#!/bin/bash
# Scenario: instances-single-box
#
# What 0.7.0 promises a box that runs alone: it is a controller with no
# members, the change log is on and records writes, and nothing it did
# before stops working. Puts a candidate release (CANDIDATE_VERSION, a
# published (pre-)release, 0.7.0+) on the host one of two ways:
#
#   fresh     install the candidate. The default: FROM_TAG is older than
#             0.6.4, the candidate's min_from, so no update from it exists.
#   upgrade   install FROM_TAG, then cidrella-update to the candidate. Taken
#             when FROM_TAG is 0.6.4 or newer (--from-tag v0.6.4), so the
#             instance tables come from migrations run on a database that
#             had none.
#
# Then, through the API as an admin and by reading the database:
# GET /api/features and GET /api/instances say controller, no members, not
# replaced, not handing over, and list this box alone; sync_state has a
# dataset and no mode row; a settings change makes a row in sync_log; a join
# token is made and carries this box's sync fingerprint; a manual backup is
# taken and listed.
#
# One host, so no second instance takes part: joining, syncing, moving DHCP
# and promotion are the two-host check in BACKLOG.md.

SCENARIO_NAME="instances-single-box"
SCENARIO_DESCRIPTION="Install or upgrade to CANDIDATE_VERSION; asserts a lone box is a controller with no members, logs changes, makes a join token and still takes a backup"

# A password that satisfies the default policy, for the harness admin.
HARNESS_PASSWORD="Harness-Instances-1"
# The oldest release the candidate updates from (RELEASE-NOTES.md, min_from).
MIN_FROM="0.6.4"
# An estate setting with no side effect, and a value a new install does not have.
LOGGED_SETTING="map_home"
LOGGED_VALUE="45,-75"

# True when FROM_TAG is a release the candidate can be updated from.
upgrades_from_tag() {
  local from="${FROM_TAG#v}"
  [ -n "$from" ] && [ "$(printf '%s\n' "$MIN_FROM" "$from" | sort -V | head -1)" = "$MIN_FROM" ]
}

# Seconds from now until an ISO 8601 UTC time.
seconds_until() {
  python3 -c 'import sys,datetime as d
t=d.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))
print(int((t-d.datetime.now(d.timezone.utc)).total_seconds()))' "$1"
}

scenario_setup() {
  if [ -z "$CANDIDATE_VERSION" ]; then
    echo "instances-single-box: CANDIDATE_VERSION is required (pass --candidate to run.sh)" >&2
    return 1
  fi
  if upgrades_from_tag; then
    echo upgrade > /tmp/instances-path.txt
    install_release_tag "$FROM_TAG" || return 1
    # A bad baseline would look like a failed update.
    wait_healthy || return 1
    cidrella-update --version "$CANDIDATE_VERSION" > /tmp/cidrella-update-output.log 2>&1
    echo "cidrella-update exit code: $?" >> /tmp/cidrella-update-output.log
  else
    echo fresh > /tmp/instances-path.txt
    install_release_tag "$CANDIDATE_VERSION" || return 1
  fi
  wait_healthy || return 1
  harness_sign_in "$HARNESS_PASSWORD"
}

scenario_run() {
  api GET /features > /tmp/instances-features.json
  api GET /instances > /tmp/instances-list.json

  # A change to the data of record lands in the change log.
  db_value 'SELECT COALESCE(MAX(seq), 0) FROM sync_log' > /tmp/instances-log-head.txt
  api PUT "/settings/$LOGGED_SETTING" "{\"value\":\"$LOGGED_VALUE\"}" > /tmp/instances-setting.json

  # A join token: shown once, so only what is checked of it is kept.
  api POST /instances/join-token > /tmp/instances-token.json
  seconds_until "$(json_field expires_at < /tmp/instances-token.json)" > /tmp/instances-token-left.txt

  api POST /operations/backup > /tmp/instances-backup.json
  api GET /operations/backups > /tmp/instances-backups.json
}

scenario_assert() {
  # ─── The build under test is what runs ────────────────
  assert_command_ok "grep -q '\"version\": \"${CANDIDATE_VERSION%%-*}' /opt/cidrella/package.json"
  if [ "$(cat /tmp/instances-path.txt 2>/dev/null)" = upgrade ]; then
    assert_command_ok "grep -q 'cidrella-update exit code: 0' /tmp/cidrella-update-output.log"
  fi
  assert_systemctl_active cidrella

  # ─── GET /api/features: a controller, alone ───────────
  assert_command_ok "test \"\$(json_field instance.mode < /tmp/instances-features.json)\" = controller"
  assert_command_ok "test \"\$(json_field instance.members < /tmp/instances-features.json)\" = 0"
  assert_command_ok "test \"\$(json_field instance.fenced < /tmp/instances-features.json)\" = False"
  assert_command_ok "test \"\$(json_field instance.handover_to < /tmp/instances-features.json)\" = None"
  assert_command_ok "test \"\$(json_field instance.controller_name < /tmp/instances-features.json)\" = None"

  # ─── GET /api/instances: this box, and nothing else ───
  assert_command_ok "test \"\$(json_field mode < /tmp/instances-list.json)\" = controller"
  assert_command_ok "test \"\$(json_field instances.0.is_controller < /tmp/instances-list.json)\" = True"
  assert_command_ok "test \"\$(json_field instances.0.is_self < /tmp/instances-list.json)\" = True"
  assert_command_ok "test \"\$(json_field instances.0.instance_id < /tmp/instances-list.json)\" = \"\$(json_field self.instance_id < /tmp/instances-list.json)\""
  assert_command_ok "! json_field instances.1 < /tmp/instances-list.json"
  assert_command_ok "test \"\$(json_field promotion.handover < /tmp/instances-list.json)\" = None"
  assert_command_ok "test \"\$(json_field promotion.fenced < /tmp/instances-list.json)\" = None"
  assert_command_ok "test \"\$(db_value 'SELECT count(*) FROM sync_instances')\" = 1"
  assert_command_ok "test \"\$(db_value 'SELECT count(*) FROM sync_instances WHERE is_controller = 1')\" = 1"

  # ─── sync_state: a dataset, and no mode row (a controller has none) ──
  assert_command_ok "test \"\$(db_value \"SELECT count(*) FROM sync_state WHERE key = 'dataset' AND value <> ''\")\" = 1"
  assert_command_ok "test \"\$(db_value \"SELECT count(*) FROM sync_state WHERE key = 'mode'\")\" = 0"

  # ─── The change log recorded the settings write ───────
  # An empty head would make the comparison below vacuous.
  assert_command_ok "grep -Eq '^[0-9]+\$' /tmp/instances-log-head.txt"
  assert_command_ok "test \"\$(json_field value < /tmp/instances-setting.json)\" = '$LOGGED_VALUE'"
  assert_command_ok "test \"\$(db_value \"SELECT count(*) FROM sync_log WHERE tbl = 'settings' AND pk = '$LOGGED_SETTING' AND op = 'u' AND seq > \$(cat /tmp/instances-log-head.txt)\")\" = 1"

  # ─── A join token: well formed, pinned to this box, 15 minutes, unused ──
  assert_command_ok "json_field token < /tmp/instances-token.json | grep -Eq '^cj1_[0-9a-f]{64}_[A-Za-z0-9_-]{20,}\$'"
  assert_command_ok "test \"\$(json_field token < /tmp/instances-token.json | cut -d_ -f2)\" = \"\$(json_field self.fingerprint < /tmp/instances-list.json)\""
  assert_command_ok "test \"\$(cat /tmp/instances-token-left.txt)\" -gt 780 && test \"\$(cat /tmp/instances-token-left.txt)\" -le 900"
  assert_command_ok "test \"\$(db_value 'SELECT count(*) FROM sync_join_tokens WHERE used_at IS NULL')\" = 1"

  # ─── Backups still work on a lone controller ──────────
  assert_command_ok "test -n \"\$(json_field filename < /tmp/instances-backup.json)\""
  assert_command_ok "test -s \"/var/lib/cidrella/backups/\$(json_field filename < /tmp/instances-backup.json)\""
  assert_command_ok "tar -tzf \"/var/lib/cidrella/backups/\$(json_field filename < /tmp/instances-backup.json)\" | grep -q 'cidrella-backup-manifest.json'"
  assert_command_ok "grep -qF \"\$(json_field filename < /tmp/instances-backup.json)\" /tmp/instances-backups.json"
}

scenario_capture() {
  capture_file "path_taken" /tmp/instances-path.txt
  capture_file "features" /tmp/instances-features.json
  capture_file "instances" /tmp/instances-list.json
  capture_file "setting_write" /tmp/instances-setting.json
  capture_file "log_head_before" /tmp/instances-log-head.txt
  capture_command "sync_state_keys" "db_value \"SELECT group_concat(key, ' ') FROM sync_state\""
  capture_command "sync_log_newest" "db_value \"SELECT group_concat(seq || ':' || tbl || ':' || pk || ':' || op, ' ') FROM (SELECT * FROM sync_log ORDER BY seq DESC LIMIT 10)\""
  # The token itself is a secret for 15 minutes: only when it ends is kept.
  capture_command "join_token_expires" "json_field expires_at < /tmp/instances-token.json"
  capture_file "backup" /tmp/instances-backup.json
  capture_command "installed_version" "grep version /opt/cidrella/package.json"
  capture_file_tail "install_output" /tmp/install-output.log 40
  capture_file_tail "update_output" /tmp/cidrella-update-output.log 60
  capture_command "cidrella_journal" "journalctl -u cidrella -n 80 --no-pager"
}

scenario_main
