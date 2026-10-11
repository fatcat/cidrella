#!/bin/bash
# Scenario: stack-switch
#
# Installs a candidate release (CANDIDATE_VERSION, a published (pre-)release
# carrying the server stack switch, 0.5.3+) and switches DNS and DHCP from
# dnsmasq to PowerDNS + Kea and back through the API, as Settings > General >
# Servers does. Asserts the PowerDNS, Kea and radvd packages were installed
# and left off, that each switch committed, which units ran after each (no
# dnsmasq on PowerDNS + Kea), that a name still resolves through the stack
# serving it, and that the choice survives a restart of CIDRella.
#
# No DHCP client takes part: a Renew or Rebind across a switch needs a
# client on the served link, which is the hardware check in BACKLOG.md.

SCENARIO_NAME="stack-switch"
SCENARIO_DESCRIPTION="Install CANDIDATE_VERSION, switch dnsmasq to PowerDNS + Kea and back via the API"

# A password that satisfies the default policy, for the harness admin.
HARNESS_PASSWORD="Harness-Stack-Switch-1"
TOKEN_FILE=/tmp/stack-token

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sk --max-time 180 -X "$method" -H "Authorization: Bearer $(cat "$TOKEN_FILE")")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$(cidrella_base_url)/api$path"
}

json_field() {
  python3 -c 'import json,sys; v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v=v[k] if isinstance(v,dict) else v[int(k)]
print(v)' "$1"
}

wait_healthy() {
  local tries=0
  rm -f /tmp/cidrella-base-url
  until curl -skf "$(cidrella_base_url)/api/health" >/dev/null 2>&1; do
    rm -f /tmp/cidrella-base-url
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && { echo "CIDRella never became healthy" >&2; return 1; }
    sleep 2
  done
}

# One A query under home.arpa, a reserved zone CIDRella always answers
# locally, sent to the DNS backend's internal port on loopback (5353 behind
# the proxy on 53, the default), so it does not depend on which interfaces a
# fresh install listens on. Any reply with our ID proves the server serving
# now answered; a timeout does not.
dns_answers() {
  python3 - <<'PY'
import socket, struct, sys
q = struct.pack('>HHHHHH', 0x1234, 0x0100, 1, 0, 0, 0)
for label in b'cidrella-harness.home.arpa'.split(b'.'):
    q += bytes([len(label)]) + label
q += b'\x00' + struct.pack('>HH', 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)
s.sendto(q, ('127.0.0.1', 5353))
data, _ = s.recvfrom(512)
sys.exit(0 if data[:2] == b'\x12\x34' else 1)
PY
}

scenario_setup() {
  if [ -z "$CANDIDATE_VERSION" ]; then
    echo "stack-switch: CANDIDATE_VERSION is required (pass --candidate to run.sh)" >&2
    return 1
  fi
  install_release_tag "$CANDIDATE_VERSION" || return 1
  wait_healthy || return 1

  # Sign in as admin: reset to a one-time password, then change it.
  local once token
  once=$(cidrella-reset-password admin | awk '/New password:/{print $3}')
  token=$(curl -sk -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$once\"}" \
    "$(cidrella_base_url)/api/auth/login" | json_field token) || return 1
  printf '%s' "$token" > "$TOKEN_FILE"
  token=$(api POST /auth/change-password \
    "{\"current_password\":\"$once\",\"new_password\":\"$HARNESS_PASSWORD\"}" | json_field token) || return 1
  printf '%s' "$token" > "$TOKEN_FILE"
}

scenario_run() {
  api GET /backend-stack > /tmp/stack-preflight.json
  dns_answers; echo $? > /tmp/stack-dns-dnsmasq.txt

  local started ended
  started=$(date +%s%N)
  api POST /backend-stack '{"stack":"pdns-kea"}' > /tmp/stack-to-pdns.json
  ended=$(date +%s%N)
  echo $(( (ended - started) / 1000000 )) > /tmp/stack-to-pdns-ms.txt
  systemctl is-active cidrella-pdns-auth cidrella-pdns-recursor cidrella-kea@dhcp4 \
    cidrella-kea@dhcp6 > /tmp/stack-units-on.txt 2>&1
  systemctl is-active cidrella-dnsmasq > /tmp/stack-dnsmasq-on-pdns.txt 2>&1
  dns_answers; echo $? > /tmp/stack-dns-pdns.txt

  # The choice survives a restart: boot reads backend_stack and keeps
  # dnsmasq stopped.
  systemctl restart cidrella
  wait_healthy
  api GET /backend-stack > /tmp/stack-state-after-restart.json
  systemctl is-active cidrella-dnsmasq > /tmp/stack-dnsmasq-after-restart.txt 2>&1

  api POST /backend-stack '{"stack":"dnsmasq"}' > /tmp/stack-to-dnsmasq.json
  api GET /backend-stack > /tmp/stack-state-dnsmasq.json
  dns_answers; echo $? > /tmp/stack-dns-back.txt
}

scenario_assert() {
  # Installed, off, and the distributions' own units kept away from the ports.
  assert_file_exists /etc/systemd/system/cidrella-kea@.service
  assert_file_exists /etc/systemd/system/cidrella-pdns-auth.service
  assert_file_exists /etc/systemd/system/cidrella-pdns-recursor.service
  assert_file_exists /etc/systemd/system/cidrella-radvd.service
  assert_command_ok "systemctl is-enabled isc-kea-dhcp4-server 2>&1 | grep -q masked"
  assert_command_ok "systemctl is-enabled radvd 2>&1 | grep -q masked"
  assert_command_ok "test \"\$(json_field targets.0.blocked < /tmp/stack-preflight.json)\" = None"
  assert_command_ok "test \"\$(cat /tmp/stack-dns-dnsmasq.txt)\" = 0"

  # dnsmasq to PowerDNS + Kea: committed, the four daemons up, dnsmasq off.
  assert_command_ok "test \"\$(json_field to < /tmp/stack-to-pdns.json)\" = pdns-kea"
  assert_command_ok "test \"\$(tr '\\n' ' ' < /tmp/stack-units-on.txt)\" = 'active active active active '"
  assert_command_ok "! grep -qx active /tmp/stack-dnsmasq-on-pdns.txt"
  assert_file_exists /var/lib/cidrella/runtime/dnsmasq.disabled
  assert_command_ok "test \"\$(cat /tmp/stack-dns-pdns.txt)\" = 0"

  # Kept across a restart.
  assert_command_ok "test \"\$(json_field current < /tmp/stack-state-after-restart.json)\" = pdns-kea"
  assert_command_ok "! grep -qx active /tmp/stack-dnsmasq-after-restart.txt"

  # And back: dnsmasq serves, the others stopped, no marker left.
  assert_command_ok "test \"\$(json_field to < /tmp/stack-to-dnsmasq.json)\" = dnsmasq"
  assert_command_ok "test \"\$(json_field current < /tmp/stack-state-dnsmasq.json)\" = dnsmasq"
  assert_systemctl_active cidrella-dnsmasq
  assert_systemctl_inactive cidrella-pdns-recursor
  assert_systemctl_inactive cidrella-kea@dhcp4
  assert_systemctl_inactive cidrella-kea@dhcp6
  assert_systemctl_inactive cidrella-radvd
  assert_file_missing /var/lib/cidrella/runtime/dnsmasq.disabled
  assert_file_missing /var/lib/cidrella/stack-switch.json
  assert_command_ok "test \"\$(cat /tmp/stack-dns-back.txt)\" = 0"
}

scenario_capture() {
  capture_file "preflight" /tmp/stack-preflight.json
  capture_file "to_pdns_kea" /tmp/stack-to-pdns.json
  capture_file "to_pdns_kea_ms" /tmp/stack-to-pdns-ms.txt
  capture_file "to_dnsmasq" /tmp/stack-to-dnsmasq.json
  capture_file "units_on" /tmp/stack-units-on.txt
  capture_command "backend_journal" \
    "journalctl -u 'cidrella-kea@*' -u cidrella-pdns-auth -u cidrella-pdns-recursor -u cidrella-radvd -n 60 --no-pager"
  capture_command "cidrella_journal" "journalctl -u cidrella -n 80 --no-pager"
  capture_file_tail "install_output" /tmp/install-output.log 40
}

scenario_main
