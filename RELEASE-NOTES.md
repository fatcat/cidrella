# CIDRella Release Notes

This file is the canonical source of truth for what shipped in each release. Each section starts with a fenced YAML metadata block consumed by the build-time release-manifest generator (introduced in v0.4.12), followed by human prose. Newest releases first.

The `min_from` field in the YAML block declares the lowest version that may upgrade *directly* to this release. An empty value (`min_from: ""`) means any prior version may jump straight to this release.

---

## v0.4.11 — 2026-04-15 [PLANNED]

```yaml
min_from: ""
breaking: false
security: true
```

### New
- **Polkit-gated systemctl path** replaces sudo for all in-app updates and dnsmasq reload/restart calls from the cidrella server. New templated worker unit `cidrella-update@.service` is started via D-Bus, authorized by `/etc/polkit-1/rules.d/49-cidrella.rules`, and runs as root with no inherited sandbox. The cidrella service account never invokes sudo for these paths anymore.
- **Stale update-status auto-recovery.** A new reaper in the server detects `update-status.json` records that claim an in-progress update but have no live worker behind them. After a 180-second grace, the record is rewritten as `failed` with a diagnostic error, exposing the UI's Dismiss button and unblocking the user. The reaper runs both lazily (on every status read) and eagerly (on server boot).
- **Polkit is now a hard install dependency.** `scripts/install.sh` installs `polkitd` (modern Debian/Ubuntu) or `policykit-1` (older), probes `pkaction --version`, and verifies the daemon is active. Failures abort the install with a diagnostic.
- **Update worker unit instances are uniquely tagged.** The systemd template instance name is `cidrella-update@VERSION_EPOCH.service`, where `EPOCH` is the wall-clock seconds at start time. Retries of the same target version no longer collide on a previously-failed instance's state.
- **`RELEASE-NOTES.md` is now the canonical release-info source.** Future build-time tooling will parse this file's YAML metadata blocks to generate a signed `releases.json` manifest (planned v0.4.12).

### Fixed
- **UI updater stuck at "Starting update..." on v0.4.8/v0.4.9 hosts.** The v0.4.8 systemd hardening on `cidrella.service` enabled seven directives (`RestrictSUIDSGID`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`, `PrivateDevices`, `LockPersonality`) that each *implicitly* set `NoNewPrivileges=yes` per `systemd.exec(5)`. The author left the explicit `NoNewPrivileges=true` commented out, knowing it would break sudo's setuid escalation, but did not catch the implicit set. Every `sudo` call from the cidrella process — including the UI updater's `sudo systemd-run` — silently failed with `sudo: unable to change to root gid: Operation not permitted`. Because the API spawned the child with `stdio: 'ignore'`, the failure was invisible: the API wrote the initial `state: starting` row to `update-status.json`, returned HTTP 202, and the panel sat there waiting for a worker that didn't exist.
- **DNS reload silently failing after blocklist or config changes.** Same root cause as above — the `cidrella-dnsmasq-hup` wrapper required sudo, which doesn't work under NoNewPrivileges. dnsmasq kept serving stale config until something forced a real restart. Replaced with `systemctl reload cidrella-dnsmasq` (gated by polkit), with `cidrella-dnsmasq.service` now exposing `ExecReload=/bin/kill -HUP $MAINPID`.
- **CLI updater preflight failing as "syntax errors" on bundled-Node-only hosts.** The v0.4.3-v0.4.10 `update.sh` preflight ran `node --check` with a bare `node`, not the resolved bundled binary. On hosts installed from a v0.4.7+ tarball with no system Node (the supported config since the bundled-runtime migration), the bare invocation hit command-not-found, and the stderr was swallowed by `2>/dev/null`, which the script then reported as "syntax errors". Result: CLI updates appeared broken with a misleading error on every bundled-Node-only host. Fixed by routing the preflight syntax check through the existing `resolve_node` helper (added in v0.4.3 but never wired into this callsite). Diagnostic output is now captured and surfaced on failure instead of being discarded.
- **Update worker error reporting.** The install handler in `server/src/routes/version.js` no longer uses `stdio: 'ignore'`. Spawn errors are captured from stderr and written into `update-status.json` as `state: failed` with the actual error string. Silent failure mode for the spawn is gone.

### Security
- The polkit migration is a defense-in-depth improvement: the cidrella service account no longer needs setuid escalation for any system-management operation. The only remaining sudo entry in `/etc/sudoers.d/cidrella` is for `arping` (used by the network scanner). Slated for removal in a follow-up via setcap on the arping binary or a Node raw-socket replacement.
- The hardening directives on `cidrella.service` are **unchanged** — the sandbox was never the problem; the use of sudo from inside it was. The implicit-NNP behavior is now acknowledged in the unit file's comment block.

### Upgrade notes
- Hosts on **v0.4.7 or earlier** are unaffected by the UI updater regression and may upgrade normally via either the UI updater or `cidrella-update`.
- Hosts on **v0.4.8 or v0.4.9** are blocked from the UI updater by the regression itself. **The CLI updater is also unreliable on these hosts because of the bare-`node` preflight bug** (see Recovery, below). The only universally reliable recovery is the manual systemctl-edit procedure.
- Hosts on **v0.4.10** can use either path: UI works (v0.4.10 introduced no new break), or `cidrella-update` works *if* the host has system Node installed. On bundled-Node-only v0.4.10 hosts, CLI still fails until v0.4.11's preflight fix lands. UI is the recommended path from v0.4.10.

### Recovery from v0.4.8 / v0.4.9 (manual systemctl-edit procedure)

You must do this from a root shell on the host. SSH in as root, or `sudo -i`.

#### Step 1 — Stop the cidrella server
```bash
systemctl stop cidrella.service
```
DNS and DHCP keep running because `cidrella-dnsmasq.service` is a separate unit and is not affected.

#### Step 2 — Override the breaking directives
```bash
systemctl edit cidrella.service
```
Paste this into the override editor:
```ini
[Service]
# Temporary override — disables the v0.4.8 hardening directives that
# implicitly set NoNewPrivileges=yes and break sudo escalation.
# v0.4.11 replaces sudo with polkit-gated systemctl, after which this
# override should be REMOVED with `systemctl revert cidrella.service`.
RestrictSUIDSGID=false
ProtectKernelTunables=false
ProtectKernelModules=false
ProtectKernelLogs=false
ProtectClock=false
PrivateDevices=false
LockPersonality=false
```
Save and exit, then:
```bash
systemctl daemon-reload
```

#### Step 3 — Clear the stuck update status
```bash
rm -f /var/lib/cidrella/update-status.json
```

#### Step 4 — Start cidrella and run the UI update
```bash
systemctl start cidrella.service
```
Wait ~10 seconds, then load the web UI, navigate to **System → Updates**, click **Check Now** if needed, and click **Install Update**. The update should proceed normally through every phase.

#### Step 5 — Revert the override after the update completes
v0.4.11's `cidrella.service` no longer needs sudo for any UI-triggered action, so the original hardening can come back unchanged.
```bash
systemctl revert cidrella.service
systemctl restart cidrella.service
```
Confirm health:
```bash
systemctl status cidrella.service
curl -sk https://localhost:8443/api/health/deep | head
```

### Why CLI recovery (`cidrella-update`) is *not* the recommended path
Two separate bugs interact:
1. The cidrella service account can't sudo from inside the hardened cidrella.service — but `cidrella-update` is invoked from a root shell, so sudo escalation is not blocked. Good so far.
2. **However**, v0.4.9's `update.sh` preflight calls `node --check` with a bare `node` binary, expecting system Node to be present. On hosts installed from the bundled-Node v0.4.7+ tarball with no system Node, that command is "not found" and the script misreports it as a syntax error in `server/src/index.js`. The CLI update appears to fail for an unrelated reason.

If your host *does* have system Node installed (e.g., you installed it manually for development, or you upgraded from a pre-v0.4.7 install), CLI recovery may work. If you're on a clean bundled-Node-only install, CLI recovery does not work on v0.4.8 / v0.4.9 — use the systemctl-edit procedure above.

This bare-`node` bug is fixed in v0.4.11; from v0.4.11 forward, CLI updates are reliable on bundled-Node-only hosts.

---

## v0.4.10 — 2026-04-14

```yaml
min_from: ""
breaking: false
security: false
```

### Known issues
**The in-app UI updater is broken on this release** due to systemd hardening that implicitly sets `NoNewPrivileges=yes`, which blocks sudo escalation from inside the cidrella service. Same root cause as v0.4.8 and v0.4.9. **Install v0.4.11 or later instead.** If you're already on v0.4.10, see the v0.4.11 entry's *Recovery* section.

### New
- **Integration test harness** at `scripts/test-harness/`. SSH-driven scenario runner with three seed scenarios (fresh-install with 32 assertions, secret-file-perms with 12, post-install-hook with 8). Agent-facing `manifest.json` with `catches`/`does_not_catch` fields so review agents can discover and use the harness without reading scenario source. JSON result emission with `schema_version: 1`. Dev-only — excluded from release tarballs via `.buildignore`.
- Validator agent (`~/.claude/agents/validator.md` §8) updated to discover and use the harness before hand-rolling validation SSH sessions.

### Fixed
- **OOM kills on small-RAM installs** (1GB LXCs were getting killed by the kernel OOM killer during DuckDB startup and during heavy log ingestion). DuckDB memory limits explicit. Logs subsystem batches and back-pressures.
- **Rotation hardening (security findings).** `scripts/lib/rotation.sh` `load_key_state` replaced `eval "$parsed"` with newline-separated values + `IFS= read -r`, closing a shell-injection vector from a crafted `.key-state.json`. Pubkey base64 charset + length bound check at parse time. `fetch_rotation_announcements` curl calls hardened with `--proto '=https' --proto-redir '=https'` so a crafted `browser_download_url` can't smuggle `file://` schemes. The undocumented `revoked_pubkey_strict_check` env bypass was removed; the check is now unconditional.
- **`update.sh` bootstrap path resolution.** `readlink -f "$0"` now runs *before* the `cd /` anchor. The prior order caused `./update.sh` invocations to resolve `$0` relative to `/`, producing `//scripts/lib` as the lib path. Added a fallback to `$INSTALL_LINK/scripts/lib` and a diagnostic that prints `$0`, the resolved path, and `$INSTALL_LINK`.
- **`update.sh` canonical-command nudge.** Direct `./update.sh` invocations now print a tip suggesting `cidrella-update` (the wrapper). Suppressed under `--from-api`.
- **Test harness `capture_command`** rewritten without the `head -c` pipefail+SIGPIPE race that silently mis-reported >4KB successful commands as `<command-failed>`.
- **`scripts/post-install.sh` header note** documenting the `set -eu` conflict with the "warn and continue" contract for future maintainers.

### Upgrade notes
- v0.4.10 is downloadable but contains the v0.4.8/v0.4.9 UI updater regression. Treat as deprecated; install v0.4.11+ instead.

---

## v0.4.9 — 2026-04-13

```yaml
min_from: ""
breaking: false
security: true
```

### Known issues
**The in-app UI updater is broken on this release** (same root cause as v0.4.8). See the v0.4.11 entry for the recovery procedure.

### New
- **Post-install hook convention.** `scripts/post-install.sh` runs after every successful install or update. Receives a structured environment (`CIDRELLA_HOOK_REASON`, `CIDRELLA_HOOK_FROM_VERSION`, `CIDRELLA_HOOK_TO_VERSION`) and follows a "warn and continue" contract — the hook does not gate the install.
- **Break-glass key rotation consumption code.** `scripts/lib/rotation.sh` consumes signed `cidrella-rotation-N.json` announcements and applies them via persisted state in `/var/lib/cidrella/.key-state.json`. Sequence-number replay protection. `not_before`/`not_after` window enforcement. Update flow consults the rotation state before fetching the next release.
- **CLI password reset audit trail.** `scripts/cidrella-reset-password` writes an `audit_log` row, populates `users.password_reset_by`, and the affected user sees a banner on next login if the reset was unauthorized.
- **Backup/restore version safety + pre-restore snapshots.** Every backup carries a manifest with `version` and `schema_version`. Restore refuses newer-than-running backups. Restore takes a `pre-restore` snapshot to `/var/lib/cidrella/snapshots/pre-restore/` before touching the live DB so a bad restore is recoverable.
- **Secret file permission tightening.** DB at 600, server.key at 600, certs/backups/anomaly directories at 700, dnsmasq state at 755 (intentional — dnsmasq drops privileges).

---

## v0.4.8 — 2026-04-12

```yaml
min_from: ""
breaking: false
security: true
```

### Known issues
**This release introduced the UI updater regression.** The systemd hardening sweep enabled directives that implicitly set `NoNewPrivileges=yes`, which broke sudo escalation from inside the cidrella service and silently disabled the in-app updater. See the v0.4.11 entry for the recovery procedure.

### New
- **Comprehensive systemd hardening sweep** on all three units (`cidrella.service`, `cidrella-dnsmasq.service`, `cidrella-anomaly.service`). `ProtectSystem=strict`, `PrivateDevices`, `ProtectKernel*`, `LockPersonality`, `RestrictSUIDSGID`, `RestrictNamespaces`, `RemoveIPC`, narrow `CapabilityBoundingSet`. Largest single attack-surface reduction the project has shipped.
- **Runtime bundle size reduction** — stripped unused tooling from the bundled Node runtime directory. ~15% smaller release tarball.
- **Break-glass minisign pubkey embedded** in `install.sh` from this release forward. Provides a recovery path if the primary release-signing key is rotated or compromised.
- **`scripts/lib/tighten-secrets.sh`** extracted for reuse between install and update flows. Schema checks hardened.
- **Build-time pubkey consistency checks.** Build script verifies that the embedded primary and break-glass pubkeys match the keys actually used to sign the release.

---

## v0.4.7 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Bundled Node runtime + bcryptjs (Phase 2 of the bulletproof update train).** Release tarballs now include their own pinned Node binary at `runtime/node/bin/node`. systemd `ExecStart` uses the bundled path, eliminating the Node ABI mismatch failure class. `bcrypt` (native module) was replaced with `bcryptjs` (pure JS) to reduce the bundled native-module surface.
- **Setcap is re-applied between extract and preflight** so the bundled Node has `cap_net_raw,cap_net_bind_service+ep` from the moment it boots, not after switchover.
- **`UPGRADING-0.4.6-to-0.4.7.md` hot-patch runbook** for users who needed to recover from the bundled-Node migration mid-flight.

### Upgrade notes
- This release introduces bundled Node. After upgrading, `node` may no longer be installed system-wide and is not required.

---

## v0.4.6 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: true
```

### New
- `.buildignore` system for excluding files from release tarballs.
- Sudoers tightening: replaced overly-broad `kill -HUP [0-9]*` rule with a dedicated `cidrella-dnsmasq-hup` wrapper that verifies the target via `/proc/<pid>/comm`. Removed the unused `nmap` rule entirely.
- `/api-browser` gated in production builds.
- Dev secret rotation script.

### Fixed
- `cd /` anchor in `update.sh`.
- `tee` log capture in install/update flows.
- Validator-agent release-hygiene checklist.

---

## v0.4.5 — 2026-04-10

```yaml
min_from: ""
breaking: false
security: false
```

### Fixed
- UI `--scope` invocation fix.
- Anomaly staleness reporting.
- `update.sh` errors are now diagnostic-sufficient on their own (no more "see line 350" type messages).
- Install-start event emission.
- Anomaly daemon restart on update.
- `backup.js` now includes `analytics.duckdb` and the anomaly model files.

---

## v0.4.4 — 2026-04-09

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Shared bash library** at `scripts/lib/`: `verify.sh`, `slots.sh`, `preflight.sh`, `systemd-install.sh`, `log.sh`. Sourced by install.sh, update.sh, and rollback.sh — single implementation per concern.
- **Structured JSONL events** at `/var/lib/cidrella/events.jsonl` from every shell script. Append-only. Format: `{ts, phase, event, data}`. CI and the test harness assert on structured events instead of string-matching log output.

---

## v0.4.3 — 2026-04-08

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Bundled Node runtime plumbing (Phase 0 of the bulletproof update train).** `update.sh` and rollback.sh learn to prefer `$INSTALL_LINK/runtime/node/bin/node` if present, fallback `/usr/bin/node`. Embedded `RELEASE.json` inside the tarball with `version`, `built_at`, `commit_sha`, `bundled_node_version`. Verified post-minisign so the downgrade guard runs against signed data.
- The downgrade guard now uses the verified `RELEASE.json` version, not the GitHub API's `tag_name`.

---

## v0.4.2 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- A/B slot layout shipped to general availability. `/opt/cidrella` is a symlink to `/opt/cidrella-a` or `/opt/cidrella-b`. Updates extract to the inactive slot, preflight on port 18443 with isolated `/tmp/cidrella-preflight` data dir, atomic symlink swap, auto-rollback on health failure.
- Pre-update DB snapshot to `/var/lib/cidrella/snapshots/pre-update/`. SQLite WAL-checkpointed, DuckDB analytics included.
- Schema version compatibility check refuses startup on new-DB-old-code (prevents unsafe rollback corruption).
- Backup manifest with `version` + `schema_version` gating restore.

---

## v0.4.1 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Installation documentation overhaul with security guidance.

---

## v0.4.0 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: true
```

### New
- Security hardening pass.
- Code quality and DRY consolidation.
- Initial release of the v0.4.x train.

---

## v0.3.0 — 2026-03-15

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Package and dependency updates.

---

## v0.2.0 — 2026-03-12

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Metrics performance improvements.

---

## v0.1.0 — 2026-03-10

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Initial public release.
- Version management and update checking system.
