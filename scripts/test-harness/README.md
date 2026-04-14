# CIDRella Test Harness

Integration test harness for CIDRella that runs end-to-end scenarios against a live target host and emits structured JSON results for agent (or human) consumption.

**Primary consumer: Claude Code review agents.** Use this harness instead of reading code when you need to know what the software actually does end-to-end. Read `manifest.json` first to discover what scenarios exist and what each one catches — you should rarely need to open a scenario's source.

## Quick start

```bash
# Run all scenarios against the default host (testerella, 10.0.0.8)
./scripts/test-harness/run.sh

# Run a specific scenario
./scripts/test-harness/run.sh --scenario fresh-install

# Run against a different host
./scripts/test-harness/run.sh --host 10.0.0.50

# Just list what scenarios exist (reads manifest.json)
./scripts/test-harness/run.sh --list
```

Results land in `scripts/test-harness/results/<scenario>-<timestamp>.json`. Stderr from the remote bash session is captured alongside as `<scenario>-<timestamp>.stderr` for runner-level debugging.

Exit codes: `0` if every scenario passed, `1` if any failed, `2` on runner error (unreachable host, missing scenario, etc).

## What "green" means (and doesn't)

**Green on testerella ≠ green on Debian.** The harness tests ONE host: testerella, a specific Debian 13 LXC with a specific kernel, systemd version, network topology, disk layout, and locale. 52/52 assertions passing tells you CIDRella installs cleanly on testerella — NOT that it installs cleanly on every supported distro.

Known gaps that green harness runs do NOT cover:
- Ubuntu 22.04 / 24.04 LTS (different systemd minor, different dnsmasq packaging)
- Debian boxes with `systemd-resolved` actually enabled (testerella has it disabled)
- Proxmox LXCs with different nesting / apparmor profiles
- Non-UTF-8 locales, non-`/var/lib/cidrella` data paths, pre-existing port-53 consumers
- Anything involving multi-interface DHCP binding

Treat harness green as "testerella didn't regress" — not "the install surface is covered." Review agents consuming the results should cite the harness as a regression signal, not as a stamp of cross-distro compatibility.

## DO NOT point this at prod

The runner wipes the target host aggressively between scenarios — stops and uninstalls CIDRella, removes `/var/lib/cidrella`, purges dnsmasq and nodejs, deletes the cidrella user. This is correct behavior for a throwaway test LXC and destructive behavior for anything real. The runner requires SSH access and assumes you are intentionally using it on an expendable host.

## How a scenario works

A scenario is a bash script in `scenarios/` that:

1. Sets `SCENARIO_NAME` and `SCENARIO_DESCRIPTION` at the top
2. Defines four functions: `scenario_setup`, `scenario_run`, `scenario_assert`, `scenario_capture`
3. Calls `scenario_main` at the end

The runner ships the scenario (plus `lib/scenario-lib.sh`) to the target host via SSH stdin. Everything runs on the remote — assertions observe local state with `systemctl`, `stat`, `curl`, etc., and emit a JSON result to stdout. The runner captures that JSON and writes it to `results/`.

### Phases

- **setup** — prep state. The runner has already wiped the host before the scenario starts, so most scenarios leave this empty or stub it.
- **run** — do the thing being validated (install, upgrade, restart, etc.).
- **assert** — a series of `assert_*` calls. Each assertion is recorded with pass/fail status and optional detail. The scenario's final status is `pass` only if every assertion passed.
- **capture** — gather observable state (files, command output, log tails) that lives in the result JSON alongside the assertion list. Captures are what make a failed assertion actionable: when the test fails, the captures answer "what was the actual state at the moment of failure?"

### Available assertion helpers

| Helper | Purpose |
|---|---|
| `assert_http_200 <url>` | HTTP GET returns 200 |
| `assert_http_status <url> <code>` | HTTP GET returns specific code |
| `assert_json_field <url> <dotted.path> <expected>` | JSON field equals expected (uses cidrella-node for parsing) |
| `assert_systemctl_active <unit>` | Systemd unit is active |
| `assert_systemctl_inactive <unit>` | Systemd unit is NOT active |
| `assert_file_exists <path>` | Path exists |
| `assert_file_missing <path>` | Path does not exist |
| `assert_file_mode <path> <octal>` | File mode matches (e.g. 600) |
| `assert_file_owner <path> <user>` | File owner matches |
| `assert_command_ok <shell-command>` | Command exits 0 |
| `assert_file_contains <path> <substring>` | File contains substring |

### Available capture helpers

| Helper | Purpose |
|---|---|
| `capture_file <label> <path>` | First 4KB of a file |
| `capture_file_tail <label> <path> [n]` | Last N lines of a file, truncated to 4KB |
| `capture_command <label> <shell-command>` | Command output (stdout+stderr), truncated to 4KB |

## Result schema

Every scenario run produces a single JSON object on stdout, also written to `results/<name>-<timestamp>.json`. Fields:

- `scenario` — scenario name (matches the filename without extension)
- `description` — human-readable summary from `SCENARIO_DESCRIPTION`
- `status` — `pass` or `fail`
- `hostname` — the target host as reported by `hostname` on the remote
- `started_at_unix_ms` — epoch milliseconds when the scenario started on the remote
- `duration_ms` — total wall time on the remote
- `assert_pass` / `assert_fail` — counts
- `assertions` — array of `{name, status, detail?}` objects
- `captures` — object: string keys → string values (file contents, command output)

The schema is also machine-readable in `manifest.json` under `result_schema` so agents don't need to guess.

## Current scenarios

See `manifest.json` for the full catalog. Brief list:

- **fresh-install** — Fresh install of the latest release + full post-install state verification. Baseline for every future feature.
- **secret-file-perms** — Verify v0.4.8+ secret file permission tightening (600 on cidrella.db, certs, etc.).
- **post-install-hook** — Verify v0.4.9 post-install hook convention: shipped, executable, invoked with correct env contract.

## Adding a new scenario

1. Copy an existing scenario in `scenarios/` that most closely matches what you want to test.
2. Update `SCENARIO_NAME` and `SCENARIO_DESCRIPTION`.
3. Implement the four functions. Start with `scenario_assert` — know what "pass" means before writing setup/run.
4. Add an entry to `manifest.json` under `scenarios` with:
   - `name`, `file`, `description`
   - `catches` — a list of bug classes the scenario prevents
   - `expected_duration_sec` — rough ceiling (for agent planning)
   - `requires_fresh_host` — whether the runner should wipe before running
5. Run it: `./scripts/test-harness/run.sh --scenario <name>`
6. Read the result JSON. If something is wrong, read the captures FIRST.

## What the harness does NOT do

- **No CI integration.** This runs manually or from a Claude session. GitHub Actions integration is a future enhancement.
- **No parallelism.** Scenarios run sequentially. Host wipes between scenarios make parallelism non-trivial without ephemeral LXC clones.
- **No upgrade-path scenarios.** All current scenarios are "fresh install + verify". Upgrade-path scenarios (install old version → upgrade → verify) are higher-effort and not yet present.
- **No signed-rotation scenarios.** Testing the break-glass rotation code path needs a real signed `rotation-announcement.json`, which requires the offline break-glass private key. Not automatable.
- **No result history or trend tracking.** Each scenario's latest result is what you see; older results accumulate in `results/` but there's no UI.
- **Not shipped in release tarballs.** The harness is dev-only, excluded via `.buildignore`.
