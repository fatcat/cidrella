#!/bin/bash
# CIDRella test-harness runtime library.
#
# Sourced by scenario scripts AFTER they're SSH-piped to the remote host.
# Provides:
#   - Assertion helpers that append to a pass/fail log
#   - Capture helpers that snapshot observable state into the result
#   - emit_result() that prints the final scenario JSON to stdout
#
# Design note: this library runs on the TARGET HOST (e.g. testerella), not
# on the dev box. The runner SSHes to the target and pipes a scenario file
# preceded by this library. All file checks, HTTP calls, and command
# captures happen locally on the target. The runner captures the final JSON
# from the SSH session's stdout.
#
# Scenarios using this library should define these functions and then call
# scenario_main at the end:
#   scenario_setup        — prepare state (install, wipe, seed data)
#   scenario_run          — the action being validated (often empty — setup is enough)
#   scenario_assert       — calls to assert_* helpers
#   scenario_capture      — calls to capture_* helpers for post-mortem observables
#
# Scenarios should also set these variables at the top:
#   SCENARIO_NAME         — short slug, e.g. "fresh-install"
#   SCENARIO_DESCRIPTION  — one-line human-readable summary

set -u

# Globals the helpers append to
ASSERT_PASS_COUNT=0
ASSERT_FAIL_COUNT=0
ASSERT_ENTRIES=""       # JSON array fragments, comma-separated
CAPTURE_ENTRIES=""      # JSON "key": "value" fragments, comma-separated
SCENARIO_START_TS=$(date +%s%3N 2>/dev/null || date +%s)

# _json_escape — escape a string for JSON embedding.
# Handles: \, ", newline, carriage return, tab, and other C0 control chars.
# Captured command output and file contents regularly contain form feed
# (0x0C), backspace (0x08), ESC, etc. — JSON requires all U+0000–U+001F to
# be escaped. The named-replacement block below covers \n \r \t; the tr
# pass strips the remaining control bytes so the emitted result JSON parses
# under strict parsers on the agent side.
_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s=$(printf '%s' "$s" | LC_ALL=C tr -d '\001-\010\013\014\016-\037\177')
  printf '%s' "$s"
}

# _append_assertion <name> <status> <detail>
_append_assertion() {
  local name="$1" status="$2" detail="${3:-}"
  local name_e detail_e
  name_e=$(_json_escape "$name")
  detail_e=$(_json_escape "$detail")
  local entry="{\"name\":\"${name_e}\",\"status\":\"${status}\""
  if [ -n "$detail" ]; then
    entry="${entry},\"detail\":\"${detail_e}\""
  fi
  entry="${entry}}"
  if [ -z "$ASSERT_ENTRIES" ]; then
    ASSERT_ENTRIES="$entry"
  else
    ASSERT_ENTRIES="${ASSERT_ENTRIES},${entry}"
  fi
  if [ "$status" = "pass" ]; then
    ASSERT_PASS_COUNT=$((ASSERT_PASS_COUNT + 1))
  else
    ASSERT_FAIL_COUNT=$((ASSERT_FAIL_COUNT + 1))
  fi
}

# _append_capture <key> <value>
_append_capture() {
  local key="$1" value="$2"
  local key_e value_e
  key_e=$(_json_escape "$key")
  value_e=$(_json_escape "$value")
  local entry="\"${key_e}\":\"${value_e}\""
  if [ -z "$CAPTURE_ENTRIES" ]; then
    CAPTURE_ENTRIES="$entry"
  else
    CAPTURE_ENTRIES="${CAPTURE_ENTRIES},${entry}"
  fi
}

# ─── Assertion helpers ───────────────────────────────────

# assert_http_200 <url>
#   Expects HTTP 200 via curl. -sk for self-signed certs.
assert_http_200() {
  local url="$1"
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "curl-failed")
  if [ "$code" = "200" ]; then
    _append_assertion "http_200 $url" pass
  else
    _append_assertion "http_200 $url" fail "got $code"
  fi
}

# assert_http_status <url> <expected-status>
assert_http_status() {
  local url="$1" expected="$2"
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "curl-failed")
  if [ "$code" = "$expected" ]; then
    _append_assertion "http_status $url == $expected" pass
  else
    _append_assertion "http_status $url == $expected" fail "got $code"
  fi
}

# assert_json_field <url> <dotted.path> <expected-value>
#   Fetches the URL via curl, extracts a JSON field, compares as string.
#   Uses cidrella-node if available, else system node, for parsing.
assert_json_field() {
  local url="$1" path="$2" expected="$3"
  local node_bin
  if [ -x /usr/local/bin/cidrella-node ]; then
    node_bin=/usr/local/bin/cidrella-node
  elif command -v node >/dev/null 2>&1; then
    node_bin=$(command -v node)
  else
    _append_assertion "json_field $url $path=$expected" fail "no node binary available"
    return
  fi
  local body actual
  body=$(curl -sk "$url" 2>/dev/null || echo '')
  actual=$(printf '%s' "$body" | FIELD_PATH="$path" "$node_bin" -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const obj = JSON.parse(d);
        const path = process.env.FIELD_PATH.split(".");
        let v = obj;
        for (const p of path) v = v?.[p];
        process.stdout.write(String(v ?? ""));
      } catch (e) { process.stdout.write("<parse-error>"); }
    });
  ' 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    _append_assertion "json_field $url $path=$expected" pass
  else
    _append_assertion "json_field $url $path=$expected" fail "got $actual"
  fi
}

# assert_systemctl_active <unit>
assert_systemctl_active() {
  local unit="$1"
  local state
  state=$(systemctl is-active "$unit" 2>&1 || true)
  if [ "$state" = "active" ]; then
    _append_assertion "systemctl is-active $unit" pass
  else
    _append_assertion "systemctl is-active $unit" fail "state=$state"
  fi
}

# assert_systemctl_inactive <unit>
assert_systemctl_inactive() {
  local unit="$1"
  local state
  state=$(systemctl is-active "$unit" 2>&1 || true)
  if [ "$state" != "active" ]; then
    _append_assertion "systemctl inactive $unit" pass "state=$state"
  else
    _append_assertion "systemctl inactive $unit" fail "expected not-active, got active"
  fi
}

# assert_file_exists <path>
assert_file_exists() {
  local path="$1"
  if [ -e "$path" ]; then
    _append_assertion "file_exists $path" pass
  else
    _append_assertion "file_exists $path" fail "not found"
  fi
}

# assert_file_missing <path>
assert_file_missing() {
  local path="$1"
  if [ ! -e "$path" ]; then
    _append_assertion "file_missing $path" pass
  else
    _append_assertion "file_missing $path" fail "exists"
  fi
}

# assert_file_mode <path> <octal-mode>
assert_file_mode() {
  local path="$1" expected="$2"
  if [ ! -e "$path" ]; then
    _append_assertion "file_mode $path == $expected" fail "file not found"
    return
  fi
  local actual
  actual=$(stat -c '%a' "$path" 2>/dev/null || echo "stat-failed")
  if [ "$actual" = "$expected" ]; then
    _append_assertion "file_mode $path == $expected" pass
  else
    _append_assertion "file_mode $path == $expected" fail "got $actual"
  fi
}

# assert_file_owner <path> <owner>
assert_file_owner() {
  local path="$1" expected="$2"
  if [ ! -e "$path" ]; then
    _append_assertion "file_owner $path == $expected" fail "file not found"
    return
  fi
  local actual
  actual=$(stat -c '%U' "$path" 2>/dev/null || echo "stat-failed")
  if [ "$actual" = "$expected" ]; then
    _append_assertion "file_owner $path == $expected" pass
  else
    _append_assertion "file_owner $path == $expected" fail "got $actual"
  fi
}

# assert_command_ok <shell-command>
#   Runs the shell command and passes if exit=0.
assert_command_ok() {
  local cmd="$1"
  if eval "$cmd" >/dev/null 2>&1; then
    _append_assertion "command_ok $cmd" pass
  else
    _append_assertion "command_ok $cmd" fail "exit=$?"
  fi
}

# assert_file_contains <path> <substring>
assert_file_contains() {
  local path="$1" needle="$2"
  if [ ! -f "$path" ]; then
    _append_assertion "file_contains $path" fail "file not found"
    return
  fi
  if grep -qF -- "$needle" "$path" 2>/dev/null; then
    _append_assertion "file_contains $path ⟨${needle:0:40}⟩" pass
  else
    _append_assertion "file_contains $path ⟨${needle:0:40}⟩" fail "substring not found"
  fi
}

# ─── Shared scenario actions ─────────────────────────────

# install_latest_release
#   Fetches install.sh from main and runs it non-interactively, capturing
#   output to /tmp/install-output.log. Used by any scenario whose scenario_run
#   needs "start from a clean host, install the latest release, then assert".
#   Returns install.sh's exit code.
install_latest_release() {
  curl -fsSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh \
    -o /tmp/install.sh || return 1
  yes y | bash /tmp/install.sh > /tmp/install-output.log 2>&1
}

# ─── Capture helpers ─────────────────────────────────────

# capture_file <label> <path>
#   Reads the file (truncated to 4KB) and appends to captures.
capture_file() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    local content
    content=$(head -c 4096 "$path" 2>/dev/null || echo "<read-failed>")
    _append_capture "$label" "$content"
  else
    _append_capture "$label" "<missing: $path>"
  fi
}

# capture_command <label> <shell-command>
#   Runs the command and captures its stdout+stderr (truncated to 4KB).
#
#   The previous version piped into `head -c 4096` with `set -o pipefail`,
#   which had a silent failure mode: when a SUCCESSFUL command produced
#   more than 4KB, `head` closed early, `eval` got SIGPIPE, pipefail
#   reported the pipeline as failed, and the capture became "<command-failed>"
#   for commands that actually worked. Capture the full output first, then
#   truncate in-process. Capture commands are for short diagnostics (service
#   state, config dumps, log tails), so the memory cost of buffering is
#   bounded in practice.
capture_command() {
  local label="$1" cmd="$2"
  local output rc=0
  output=$(eval "$cmd" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$output" ]; then
    output="<command-failed rc=${rc}>"
  fi
  output="${output:0:4096}"
  _append_capture "$label" "$output"
}

# capture_file_tail <label> <path> <n-lines>
capture_file_tail() {
  local label="$1" path="$2" n="${3:-20}"
  if [ -f "$path" ]; then
    local content
    content=$(tail -n "$n" "$path" 2>/dev/null | head -c 4096 || echo "<read-failed>")
    _append_capture "$label" "$content"
  else
    _append_capture "$label" "<missing: $path>"
  fi
}

# ─── Result emission ─────────────────────────────────────

# emit_result
#   Prints the final scenario result as a single JSON object to stdout.
#   The runner captures this from the SSH session's stdout.
#
#   Overall status: "pass" if no assertion failed, "fail" otherwise.
emit_result() {
  local end_ts duration_ms status
  end_ts=$(date +%s%3N 2>/dev/null || date +%s)
  duration_ms=$((end_ts - SCENARIO_START_TS))
  if [ "$ASSERT_FAIL_COUNT" -eq 0 ]; then
    status="pass"
  else
    status="fail"
  fi
  local name_e desc_e hostname_e
  name_e=$(_json_escape "${SCENARIO_NAME:-unknown}")
  desc_e=$(_json_escape "${SCENARIO_DESCRIPTION:-}")
  hostname_e=$(_json_escape "$(hostname 2>/dev/null || echo unknown)")
  # schema_version is the SHAPE version of this JSON object. Bump on any
  # breaking change (renamed/removed field, type change). Agents reading
  # archived result files branch on this value, so the key must be first.
  cat <<JSON
{"schema_version":1,"scenario":"${name_e}","description":"${desc_e}","status":"${status}","hostname":"${hostname_e}","started_at_unix_ms":${SCENARIO_START_TS},"duration_ms":${duration_ms},"assert_pass":${ASSERT_PASS_COUNT},"assert_fail":${ASSERT_FAIL_COUNT},"assertions":[${ASSERT_ENTRIES}],"captures":{${CAPTURE_ENTRIES}}}
JSON
}

# scenario_main
#   Default top-level orchestration. Scenarios can override if they need
#   different ordering. Calls setup, run, assert, capture, then emit_result.
#   Traps errors so even a partial scenario produces a result JSON.
scenario_main() {
  # If any of the phases fail catastrophically, we still want to emit what
  # we have. Each phase is wrapped so an exit inside it doesn't kill the
  # emit_result call at the end.
  if declare -F scenario_setup >/dev/null; then
    scenario_setup || _append_assertion "scenario_setup" fail "exit=$?"
  fi
  if declare -F scenario_run >/dev/null; then
    scenario_run || _append_assertion "scenario_run" fail "exit=$?"
  fi
  if declare -F scenario_assert >/dev/null; then
    scenario_assert || true
  fi
  if declare -F scenario_capture >/dev/null; then
    scenario_capture || true
  fi
  emit_result
}
