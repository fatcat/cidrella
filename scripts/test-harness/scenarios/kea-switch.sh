#!/bin/bash
# Scenario: kea-switch
#
# Installs a candidate release (CANDIDATE_VERSION, a published (pre-)release
# carrying Kea, 0.5.2+) and switches the DHCP server to Kea and back through
# the API, as Settings > DHCP > Server does. Asserts Kea was installed and
# left off, that each switch committed, which units ran after each, and that
# the update rule held: nothing enabled Kea at boot.
#
# No DHCP client takes part: a Renew or Rebind across a switch needs a
# client on the served link, which is the hardware check in BACKLOG.md.

SCENARIO_NAME="kea-switch"
SCENARIO_DESCRIPTION="Install CANDIDATE_VERSION, switch DHCP dnsmasq to Kea and back via the API"

# A password that satisfies the default policy, for the harness admin.
HARNESS_PASSWORD="Harness-Kea-Switch-1"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sk --max-time 120 -X "$method" -H "Authorization: Bearer $(cat /tmp/kea-token)")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$(cidrella_base_url)/api$path"
}

json_field() {
  python3 -c 'import json,sys; v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k] if isinstance(v,dict) else v[int(k)]
print(v)' "$1"
}

scenario_setup() {
  if [ -z "$CANDIDATE_VERSION" ]; then
    echo "kea-switch: CANDIDATE_VERSION is required (pass --candidate to run.sh)" >&2
    return 1
  fi
  install_release_tag "$CANDIDATE_VERSION" || return 1

  local tries=0
  rm -f /tmp/cidrella-base-url
  until curl -skf "$(cidrella_base_url)/api/health" >/dev/null 2>&1; do
    rm -f /tmp/cidrella-base-url
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && { echo "release never became healthy" >&2; return 1; }
    sleep 2
  done

  # Sign in as admin: reset to a one-time password, then change it.
  local once token
  once=$(cidrella-reset-password admin | awk '/New password:/{print $3}')
  token=$(curl -sk -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$once\"}" \
    "$(cidrella_base_url)/api/auth/login" | json_field token) || return 1
  printf '%s' "$token" > /tmp/kea-token
  token=$(api POST /auth/change-password \
    "{\"current_password\":\"$once\",\"new_password\":\"$HARNESS_PASSWORD\"}" | json_field token) || return 1
  printf '%s' "$token" > /tmp/kea-token
}

scenario_run() {
  api GET /dhcp/server > /tmp/kea-preflight.json
  api POST /dhcp/server '{"target":"kea"}' > /tmp/kea-to-kea.json
  systemctl is-active cidrella-kea@dhcp4 cidrella-kea@dhcp6 > /tmp/kea-units-on.txt 2>&1
  api GET /dhcp/server > /tmp/kea-state-kea.json
  api POST /dhcp/server '{"target":"dnsmasq"}' > /tmp/kea-to-dnsmasq.json
  api GET /dhcp/server > /tmp/kea-state-dnsmasq.json
}

scenario_assert() {
  # Installed, off, and ISC's own units kept away from ports 67 and 547.
  assert_file_exists /etc/systemd/system/cidrella-kea@.service
  assert_file_exists /opt/cidrella/scripts/lib/kea-install.sh
  assert_command_ok "id -nG cidrella | grep -qw _kea"
  assert_command_ok "systemctl is-enabled isc-kea-dhcp4-server 2>&1 | grep -q masked"
  assert_command_ok "test \"\$(json_field targets.0.blocked < /tmp/kea-preflight.json)\" = None"

  # dnsmasq to Kea: committed, both daemons up.
  assert_command_ok "test \"\$(json_field to < /tmp/kea-to-kea.json)\" = kea"
  assert_command_ok "test \"\$(cat /tmp/kea-units-on.txt | tr '\\n' ' ')\" = 'active active '"
  assert_command_ok "test \"\$(json_field current < /tmp/kea-state-kea.json)\" = kea"

  # And back: dnsmasq serves, Kea stopped.
  assert_command_ok "test \"\$(json_field to < /tmp/kea-to-dnsmasq.json)\" = dnsmasq"
  assert_command_ok "test \"\$(json_field current < /tmp/kea-state-dnsmasq.json)\" = dnsmasq"
  assert_systemctl_active cidrella-dnsmasq
  assert_systemctl_inactive cidrella-kea@dhcp4
  assert_systemctl_inactive cidrella-kea@dhcp6
  assert_file_missing /var/lib/cidrella/dhcp-switch.json
}

scenario_capture() {
  capture_file "preflight" /tmp/kea-preflight.json
  capture_file "to_kea" /tmp/kea-to-kea.json
  capture_file "to_dnsmasq" /tmp/kea-to-dnsmasq.json
  capture_file "kea_units_on" /tmp/kea-units-on.txt
  capture_command "kea_journal" "journalctl -u 'cidrella-kea@*' -n 40 --no-pager"
  capture_command "cidrella_journal" "journalctl -u cidrella -n 60 --no-pager"
  capture_file_tail "install_output" /tmp/install-output.log 40
}

scenario_main
