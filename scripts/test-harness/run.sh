#!/bin/bash
# CIDRella test-harness runner.
#
# Executes one or more scenarios against a target host (default testerella).
# Each scenario is shipped to the host via SSH stdin, runs fully on the
# remote, emits a structured JSON result, and the runner aggregates the
# results into scripts/test-harness/results/ and a top-level summary for
# the caller (agent or human) to parse.
#
# Usage:
#   ./run.sh                          # run all scenarios against testerella
#   ./run.sh --host HOST              # override target host
#   ./run.sh --scenario NAME          # run a specific scenario (repeatable)
#   ./run.sh --no-reset               # skip the host wipe between scenarios
#   ./run.sh --list                   # print manifest.json and exit
#
# Exit codes:
#   0: all scenarios passed
#   1: at least one scenario failed
#   2: runner error (bad args, SSH unreachable, etc.)
#
# Design note: scenarios run sequentially with a host wipe between each,
# so a scenario that mutates system state doesn't pollute the next. The
# wipe is expensive (~20-40s on testerella) but correctness is worth it.
# An optional --no-reset flag skips the wipe for scenarios that don't
# require a clean slate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIB_FILE="$SCRIPT_DIR/lib/scenario-lib.sh"
SCENARIO_DIR="$SCRIPT_DIR/scenarios"
RESULTS_DIR="$SCRIPT_DIR/results"
MANIFEST_FILE="$SCRIPT_DIR/manifest.json"

HOST="${HOST:-10.0.0.8}"
# Upgrade-path scenario inputs (harmless for scenarios that ignore them):
# FROM_TAG is the release installed first, CANDIDATE_VERSION is the published
# (pre-)release cidrella-update jumps to. See scenarios/upgrade-path.sh.
FROM_TAG="${FROM_TAG:-v0.4.15}"
CANDIDATE_VERSION="${CANDIDATE_VERSION:-}"
REQUESTED=()
DO_RESET=1
LIST_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --scenario) REQUESTED+=("$2"); shift 2 ;;
    --from-tag) FROM_TAG="$2"; shift 2 ;;
    --candidate) CANDIDATE_VERSION="$2"; shift 2 ;;
    --no-reset) DO_RESET=0; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$LIST_ONLY" = "1" ]; then
  if [ -f "$MANIFEST_FILE" ]; then
    cat "$MANIFEST_FILE"
  else
    echo "manifest.json not found at $MANIFEST_FILE" >&2
    exit 2
  fi
  exit 0
fi

mkdir -p "$RESULTS_DIR"

# ─── Pre-flight: lib and scenario dir exist ──────────────
[ -f "$LIB_FILE" ] || { echo "Error: missing $LIB_FILE" >&2; exit 2; }
[ -d "$SCENARIO_DIR" ] || { echo "Error: missing $SCENARIO_DIR" >&2; exit 2; }

# ─── Pre-flight: host reachable ──────────────────────────
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "root@$HOST" 'echo ok' >/dev/null 2>&1; then
  echo "Error: host root@$HOST unreachable via SSH" >&2
  exit 2
fi

# ─── Determine which scenarios to run ────────────────────
scenarios_to_run=()
if [ "${#REQUESTED[@]}" -gt 0 ]; then
  for name in "${REQUESTED[@]}"; do
    candidate="$SCENARIO_DIR/${name}.sh"
    if [ ! -f "$candidate" ]; then
      echo "Error: scenario '$name' not found at $candidate" >&2
      exit 2
    fi
    scenarios_to_run+=("$candidate")
  done
else
  # Run all .sh files in the scenario dir, sorted
  while IFS= read -r -d '' f; do
    scenarios_to_run+=("$f")
  done < <(find "$SCENARIO_DIR" -maxdepth 1 -name '*.sh' -type f -print0 | sort -z)
fi

if [ "${#scenarios_to_run[@]}" -eq 0 ]; then
  echo "Error: no scenarios to run" >&2
  exit 2
fi

echo "=== CIDRella test harness ==="
echo "  host:      root@$HOST"
echo "  scenarios: ${#scenarios_to_run[@]}"
echo "  results:   $RESULTS_DIR"
echo ""

# ─── Reset host helper ───────────────────────────────────
# Wipes all CIDRella state on the target. Intentionally aggressive.
# intended for throwaway test hosts only. DO NOT RUN AGAINST PROD.
reset_host() {
  echo "[reset] wiping host..."
  ssh "root@$HOST" bash <<'RESET'
set -eu
systemctl stop cidrella cidrella-dnsmasq cidrella-anomaly 2>/dev/null || true
systemctl disable cidrella cidrella-dnsmasq cidrella-anomaly 2>/dev/null || true
systemctl reset-failed cidrella-update cidrella-dnsmasq 2>/dev/null || true
rm -f /etc/systemd/system/cidrella*.service /etc/sudoers.d/cidrella /usr/local/bin/cidrella-*
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/cidrella* /var/lib/cidrella /tmp/install.sh /tmp/install-output.log /tmp/hook-sentinel-* /tmp/cidrella*
apt-get purge -y dnsmasq dnsmasq-base nodejs sqlite3 >/dev/null 2>&1 || true
apt-get autoremove -y >/dev/null 2>&1 || true
userdel cidrella 2>/dev/null || true
rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg
RESET
}

# ─── Run one scenario ────────────────────────────────────
# Pipes the lib + scenario file into a remote bash and captures the JSON
# result from stdout. Stderr is captured into a separate log for
# debugging. Writes result to $RESULTS_DIR/<name>-<ts>.json.
run_scenario() {
  local scenario_file="$1"
  local name
  name=$(basename "$scenario_file" .sh)
  local ts
  ts=$(date +%Y%m%dT%H%M%S)
  local result_file="$RESULTS_DIR/${name}-${ts}.json"
  local stderr_file="$RESULTS_DIR/${name}-${ts}.stderr"

  echo "[run] $name"
  # Cat lib + scenario into SSH stdin. The remote bash reads it all, then
  # scenario_main runs because it's called at the bottom of each scenario
  # file. The last line on stdout is the JSON result.
  local ssh_output
  if ssh_output=$(cat "$LIB_FILE" "$scenario_file" \
    | ssh "root@$HOST" "TERM=dumb FROM_TAG='$FROM_TAG' CANDIDATE_VERSION='$CANDIDATE_VERSION' bash -s" 2>"$stderr_file"); then
    # Extract the last line, that's the result JSON
    local json_line
    json_line=$(printf '%s' "$ssh_output" | tail -n 1)
    if [ -n "$json_line" ] && [ "${json_line:0:1}" = "{" ]; then
      printf '%s\n' "$json_line" > "$result_file"
      # Parse status for the summary.
      # IMPORTANT: use `grep -o ... | head -1` for `status`, not a greedy
      # `sed 's/.*"status":"..."/'`. Every assertion entry in the assertions
      # array also has a "status" field, and greedy `.*` would match the
      # LAST one in the line, so a scenario whose overall status is "fail"
      # but whose final assertion passed would report status=pass. First
      # match in the JSON is the top-level scenario status.
      local status
      status=$(printf '%s' "$json_line" | grep -o '"status":"[^"]*"' | head -1 | sed 's/.*:"\([^"]*\)"/\1/')
      # assert_pass / assert_fail / duration_ms appear only at the top level
      # (assertion entries don't carry these names) so a first-match grep
      # is equally safe and consistent with the status extraction above.
      local pass
      pass=$(printf '%s' "$json_line" | grep -o '"assert_pass":[0-9]*' | head -1 | sed 's/.*://')
      local fail
      fail=$(printf '%s' "$json_line" | grep -o '"assert_fail":[0-9]*' | head -1 | sed 's/.*://')
      local duration
      duration=$(printf '%s' "$json_line" | grep -o '"duration_ms":[0-9]*' | head -1 | sed 's/.*://')
      printf '       status=%s  pass=%s  fail=%s  (%sms)\n' \
        "${status:-?}" "${pass:-?}" "${fail:-?}" "${duration:-?}"
      printf '       result: %s\n' "$result_file"
      [ "$status" = "pass" ]
      return $?
    else
      echo "[error] $name: scenario did not emit a JSON result on stdout" >&2
      echo "[error] $name: last line was: ${json_line:0:200}" >&2
      echo "[error] $name: stderr log: $stderr_file" >&2
      return 1
    fi
  else
    echo "[error] $name: ssh bash -s exited non-zero" >&2
    echo "[error] $name: stderr log: $stderr_file" >&2
    return 1
  fi
}

# ─── Main loop ───────────────────────────────────────────
overall_pass=0
overall_fail=0
run_result_files=()

for scenario in "${scenarios_to_run[@]}"; do
  if [ "$DO_RESET" = "1" ]; then
    reset_host
  fi
  if run_scenario "$scenario"; then
    overall_pass=$((overall_pass + 1))
  else
    overall_fail=$((overall_fail + 1))
  fi
  # Track the most recent result file for the summary
  name=$(basename "$scenario" .sh)
  latest=$(ls -t "$RESULTS_DIR/${name}-"*.json 2>/dev/null | head -1 || true)
  [ -n "$latest" ] && run_result_files+=("$latest")
done

# ─── Summary ─────────────────────────────────────────────
echo ""
echo "=== SUMMARY ==="
echo "  passed: $overall_pass"
echo "  failed: $overall_fail"
echo ""
echo "=== RESULTS ==="
for f in "${run_result_files[@]}"; do
  basename "$f"
done

if [ "$overall_fail" -gt 0 ]; then
  exit 1
fi
exit 0
