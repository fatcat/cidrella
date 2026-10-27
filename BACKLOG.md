# CIDRella Backlog

Work that is **in flight**: started, deferred, or blocked on something else. Every item here
has already had thought or code spent on it.

**This is not the TODO list.** New ideas that have not begun development belong in
[TODO.md](TODO.md). When a TODO item starts moving and acquires context worth keeping (a
blocker, a measurement, a rejected approach), it graduates to here.

Related files and what they are for:
- [TODO.md](TODO.md): not started, no context yet.
- [PLAN.md](PLAN.md): phase history and shipped release trains.
- [RELEASE-NOTES.md](RELEASE-NOTES.md): canonical record of what actually shipped.
- [REVIEW.md](REVIEW.md): known issues not fixed yet (tracked since 2026-10-01; it was
  untracked before and was lost once). An entry moves here once work on it starts and stalls.

Consolidated 2026-08-19 from four places that had drifted apart: `REVIEW.md` Active Findings,
`PLAN.md` "Backlog (deferred)", `docs/SESSION-STATUS.md` "Next Resume", and the memory
`project_*` files.

---

## IPv6, what is left

IPv6 shipped across 0.5.x behind the `ipv6_enabled` switch (backend, rogue detection, UI,
DHCPv6 option catalog; RELEASE-NOTES has the detail). Still deferred:
- A grid presentation for an IPv6 network (would need gap markers and a redesigned ruler); an
  IPv6 network is a table only (`effectivePresentation` in `NetworksWorkspace.vue`).
- Full IPv6 support in the classic views (out of scope; they go with the classic-view removal).
- No DUID or IAID column in the workspace column catalog.
- No IPv6 NTP default is baked (the bundled pool is IPv4 literals).

Known limits that still hold, on dnsmasq:
- A DHCPv6 lease line without a client DUID (dnsmasq writes `*`) is skipped: no identity.
- `ra-names` (naming SLAAC hosts from their DHCPv4 lease) is emitted for the `stateless` mode
  only.
- `dhcp_release6` needs the appliance's own non-link-local IPv6 address on the lease's link.

Rogue router detection reads the kernel's `proto ra` default routes, so it needs `accept_ra` on
the interface (reported per interface as unsupported, never as clean), carries no RDNSS (the
kernel does not keep it), and sends no Router Solicitation (needs a raw ICMPv6 socket; `rdisc6`
from `ndisc6` would do it, not bundled).

## Deferred design work

### Process isolation and event-loop blocking (target 0.6.3)

Found 2026-10-25, while fixing AUTH-PATH-REDOS-01: a slow request handler stalled DNS, because
the DNS proxy runs in the same Node process as the web API and login. A survey of the main
process turned up three pieces of work, in this order.

1. **Stop blocking the event loop with synchronous child processes.** Every one of these freezes
   the whole process, the DNS proxy included, until it returns:
   - `utils/backup.js`: archive build and restore run `tar` (and `cp`) through `spawnSync` and
     `execFileSync`. A scheduled backup stops DNS answers for as long as tar runs. Measured on
     prod as BACKUP-STALL-01 in REVIEW.md: 13 s with no DNS answer. Since 0.6.2 the build also
     runs `VACUUM INTO` and a `VACUUM` on the main thread, which async `spawn` does not fix: they
     need a worker thread.
   - `backends/shared/unit-control.js`: start, stop, restart and reload use synchronous
     `systemctl` (or `pkill`), and `systemctl restart` waits for the unit to come up. A PowerDNS
     or Kea restart can take seconds.
   - Smaller: the Kea config check (`kea-dhcp4 -t`, `backends/kea/index.js`), `df` and `ping` in
     `routes/health.js`, `ip -6 neigh` in `utils/nd-cache.js`, `ip -6 route` in
     `utils/ra-monitor.js`, `utils/ntp-status.js`, and the rest of the `execFileSync` callers
     (`grep -rln "execSync\|execFileSync\|spawnSync" server/src`).

   Fix: async `execFile`/`spawn` with a timeout. Callers that rely on the call finishing before
   the next line (bypass's `setBypassListen`, the after-commit hooks) have to await it, so check
   each one's ordering rather than converting blindly. No new process needed.

2. **Move the DNS proxy into its own service.** A `cidrella-dns-proxy` systemd unit, and an s6
   longrun in Docker. What the shared process costs today:
   - One event loop: any slow handler delays every DNS answer.
   - Port 53 belongs to the proxy, and the backend sits on an internal port behind it, so every
     `systemctl restart cidrella` in `update.sh` leaves port 53 unanswered until the new process
     boots and binds again. That undoes the old rule that updates never restart the DNS daemon.
     Inferred from the code, not timed.
   - The health monitor and bypass (`startHealthMonitor`, `activateBypass` in
     `utils/dns-proxy.js`) live in the same process. They catch the proxy's sockets closing, not
     the process crashing or the loop hanging, so neither puts the backend on port 53. A crash
     waits out `RestartSec=5` plus boot.

   Shape: the main app becomes the outside watchdog that turns bypass on and off. Updates leave
   the unit running unless its code changed (`update.sh` must learn when to restart it, across
   the A/B slots). The coupling to replace, as of `1f33247`: the proxy imports settings, the
   database, `recordAudit`, the backend registry and `applyListenNow`; nine modules import from
   it (`index.js`, `services/dhcp-lease-sync.js`, `routes/interfaces.js`, `routes/geoip.js`,
   `routes/blocklists.js`, `routes/metrics.js`, `routes/analytics.js`, `utils/blocklist.js`,
   `utils/metrics-aggregator.js`) to reload its blocklist, GeoIP and filtering state, read
   status and the `getAndReset*` counters, and rebind. Each becomes a message or a database
   poll. A worker thread was considered and is the smaller step, but it fixes only the shared
   event loop, not crashes or update restarts.

3. **Take raw sockets away from the web process.** `cidrella.service` runs the login page and
   every API route with `CAP_NET_RAW` and `CAP_NET_BIND_SERVICE`, plus the polkit and sudo
   rights to control daemons and start updates. A bug in any route gets all of it. Moving the
   network probes (the scanner, the DHCP probes, rogue DHCP detection) out with the proxy lets
   the web process drop `CAP_NET_RAW`; it keeps `CAP_NET_BIND_SERVICE` only if it serves on 443.
   Daemon control behind a small privileged helper is cleaner still, but a bigger job; decide
   that once 2 is done.

Looked at and fine in-process: the scanner's tool runs (async `execFile`), DuckDB (its own
threads), the blocklist refresh (streamed), lease sync, the vendor and update checks, and the
metrics aggregator. Not the blocklist stats read, which scans the whole domain table on the main
thread: BLOCKLIST-STATS-STALL-01 in REVIEW.md, measured at up to 3 s with no DNS answer.

### PowerDNS + Kea stack (shipped in 0.6.0), what is left

Decided 2026-10-07: a host runs one of two stacks, **dnsmasq** (DNS, DHCP, RAs) or
**PowerDNS + Kea**, never a mix. The switch moves between stacks both ways, from the setup
wizard at install and from Settings afterward. `install.sh` and `update.sh` install both
stacks' packages, since the app cannot install anything itself. 0.5.2 and 0.5.3 were dev
branches with release candidates only; the release is 0.6.0. Why stacks and not one-way: the
mixed mode is what needs dnsmasq's not-serving render and two daemons on UDP 547, while
one-way switching saved three lines of lease import and broke restoring a pre-switch backup.

0.5.2 put in the Kea adapter, the lease handover and Kea's packaging. 0.5.3 (plan
`~/.claude/plans/tender-moseying-pascal.md`, design in `docs/DNSMASQ-COUPLING.md`) made the
stack selectable: the PowerDNS adapter, radvd for the Router Advertisements, the
`backend_stack` setting and its switch (Settings > General > Servers and the setup wizard),
PTR synthesis and the reserved zones in PowerDNS, the proxy's `forward_unknown` retry, the
per-role log viewer, the mixed mode removed, and pre-release-only versions kept out of
`releases.json` (`[pre-release]` on the heading). Left over:

- **Run the `stack-switch` harness scenario from a release candidate.** The switch has run
  under systemd with the real daemons: testerella on 2026-10-10 (the dev tree from
  `deploy-lxc.sh`, then `install_kea`, `install_pdns`, `install_radvd` and the polkit rule by
  hand, since `deploy-lxc.sh` installs none of them), four switches each way, 1.3 to 2.7 s
  each with about a second of DNS unanswered, all 19 leases carried every time, and the
  PowerDNS + Kea stack kept across a CIDRella restart and a reboot. Not yet run: the scenario
  itself, which installs a candidate release with `install.sh`.
- **Verify on hardware** (testerella, both directions, v4 and v6 clients): Renew and Rebind
  across a switch; that dnsmasq loads a handed-over lease file on the restart that makes it
  serve; how long a lease handed out between Kea's SIGHUP and the final lease read could be
  missed; radvd's advertisements seen by a client (`rdisc6`) against dnsmasq's.
- **The gaps against dnsmasq still open** (DNSMASQ-COUPLING.md, "Known gaps"): a reverse
  lookup for an address outside every CIDRella network, `ra-names` and bare DHCP hostnames,
  the `forward_unknown` retry in bypass mode and without DNSSEC validation.
- **Authoritative 5.1 is blocked.** 5.1.4's API refuses a TXT value holding `\"` or a
  `\DDD` escape above 127 (verified on the spike container, 2026-10-10). Native installs pin
  `auth-50`. Recheck on each 5.1 release; the live test's `intl` record is the check.
- **Recursor 5.3 or 5.4.** Native pins `rec-53`; Alpine 3.24 (the Docker image) ships 5.4.5
  and has no 5.3. The rendered config checks and runs on both, but only 5.3 has run the live
  test. Pick one series for both, or run the live test on 5.4 too.
- **Authoritative's schema on upgrade.** `prepare()` creates the gsqlite3 database from the
  package's schema when it is missing and never upgrades it. The database is derived, so the
  simple path on a schema change is to delete it and let the next sync rebuild it; nothing
  detects that need yet.

### Resolver instrumentation: what the 2026-10-08 pass left out

The resolver pass (failed-answer causes, `metrics_forwarder`, the probing
Forwarders chip, the Performance board) covers every upstream; plain
forwarding got its counts when it moved into the forwarder (2026-10-08). One
part was left out on purpose:

- **Alerts.** A failure rate or failover count crossing a line should notify
  someone. That belongs with the error-reporting release (the user's ruling),
  not here; the minute rows are what it will read.

### Workspace UI (0.5.0), what is left

Spec: [docs/WORKSPACE-UI-IMPLEMENTATION-PLAN.md](docs/WORKSPACE-UI-IMPLEMENTATION-PLAN.md). P0
through P10 landed on `dev/0.5.0` (the cutover on 2026-09-17: `/networks` and `/system` are the
workspaces, the classic views at `/networks-classic`, `/system-classic` and
`/anomalies-classic`). Open:
- **Remove the classic views** (`SubnetsLayoutB.vue`, `Settings.vue`, `SubnetDetail.vue`,
  `Anomalies.vue` and their routes), the follow-up the plan names after practical validation.
  They still hold the last `TabView` and several baselined pills.
- **Intelligence drill-down drawer.** The server reads exist
  (`/analytics/domain/:name/clients`, `/analytics/client/:ip/domains`, `routes/analytics.js`)
  but nothing in the client calls them yet; also honor the Dashboard's `?q=` link on arrival.
- **Allowlisted answers as a verdict.** The proxy logs an allowlisted answer as plain `allowed`;
  stamping `block_reason = 'allowlist'` would let Intelligence say "permitted because you
  allowlisted it".
- **W-07, partial:** the long network title wraps word by word beside the action group at
  1280 px and below; readable, not pretty.

### UI redesign: remaining scope

The left-rail redesign is **partially done**. A granular pass shipped 2026-04-18/19 (all 8 steps
of `redesign_spec.md` plus the Range Map tab, nav font +30%, IP Management left rail) and the
Settings A+C shell shipped 2026-06-09. The app is still top-nav, deliberately.

Remaining:
- **Unified status system** (StatusDot / StatusBadge, one vocabulary:
  `state-ok | state-warn | state-err | state-info | state-idle`, deleting the aliases). This is
  where the 2026-07-23 review deferrals live: WCAG 1.4.1 color-only dots, red-badge-on-warn-chip,
  and rogue yellow/orange drift. **Dots done 2026-09-21**: every status dot outside the classic
  views renders through StatusDot (the ESLint `no-restricted-class` baseline is down to 8 files,
  all badges/pills). **Pills still open**: the files baselined in `eslint.config.mjs` hand-build a pill or badge, and they are
  three different things (address type, record source, lease state), so the fix is likely
  three components, not one StatusBadge.
- **Scoped CSS drift** (from the 2026-09-21 reuse pass; the identical set moved to
  `assets/utilities.css`, `assets/panel-chrome.css` and `range-dialogs.css`). What is left in
  `check-scoped-css-dupes.js --drift` needs a decision on which body is right before it can be
  hoisted: `.field-help` (7 versions), `.form-grid` (4), `.field` (3), `.content-card` (3),
  plus the settings-card grammar (`.setting-group`, its `:last-child` and `h3`, `.settings-actions`)
  that belongs in one settings sheet. The classic views (`SubnetsLayoutB`, `SubnetDetail`,
  `Anomalies.vue`) keep their copies until they are removed.
- **API token revoke has no confirmation** (`Users.vue`, the in-table `Revoke` button deletes on
  click). Noticed while converting the confirm dialogs; a one-line `ConfirmDialog` swap once
  someone decides it should ask.
- **Empty states** for every table-backed view.

Note the original design-bundle paths in the memory file point at 2026-04-18 `/tmp` locations
that no longer exist.

### Anomaly identity: full MAC scope (lease history + IP-spanning DNS aggregation)

Migration 055 and the sidecar changes shipped the **minimal** half of this: `anomaly_scores`,
`anomaly_models` and `anomaly_allowlist` are keyed by an `identity` resolved at train/score time
(the MAC from the device's *current* DHCP lease, falling back to the IP when there is none). That
closes the safety-critical bug — a device taking over another host's IP no longer inherits its
learned baseline, and a allowlist entry now survives a renewal.

What it does **not** close: feature extraction is still IP-keyed, because the DuckDB DNS log has
no MAC column — `features.get_client_history_hours()` / `extract_training_data()` /
`extract_features_with_history()` all take a `client_ip`. So when a device renews onto a new IP,
its identity and allowlist carry over but its *observable history* resets, and it drops back to
`learning` until it re-accumulates `anomaly_min_training_hours` at the new address.

The full fix needs both halves:
- A **lease-history table** (MAC, IP, first_seen, last_seen), since `dhcp_leases` only holds the
  current binding and cannot answer "which IPs did this MAC hold over the training window".
- **DuckDB queries that aggregate across that MAC's IP intervals** rather than a single IP,
  time-bounding each IP to the window it was actually leased to that MAC (otherwise a recycled
  address pulls the previous tenant's queries back into the baseline — the exact contamination
  the minimal fix was for).

Deliberately deferred: the minimal fix removes the wrong-baseline hazard, and a temporary
`learning` reset after a renewal is a conservative failure mode (it under-reports, it does not
mis-attribute). Do not start the full scope without the lease-history table — an IP-spanning
query without lease intervals is worse than the current behavior.

Also noted while doing this work, out of scope and unstarted:
- Encrypted DNS (DoH/DoT) from a client bypasses the appliance's resolver entirely, so such a
  device is invisible to scoring rather than flagged as quiet.

---

## Specs and invariants to honor when the work starts

### Backup/restore CLI: seven non-negotiable invariants

These MUST be honored when `scripts/backup.sh` and `scripts/restore.sh` are built. They exist
because a running CIDRella service is not a reliable prerequisite for restore: the whole point of
restore is to recover from a broken install.

1. **`restore.sh` MUST be fully standalone.** No API call, no node dependency, no dependence on
   any file inside `/opt/cidrella-*`. Same pattern as `rollback.sh`: pure bash, inline helpers, no
   `source` outside `/usr/local/lib/cidrella/` or its own fallbacks. Restore is exactly the
   scenario where CIDRella is broken, so `POST /api/operations/restore` against a dead server
   fails. Users reach for restore.sh precisely when the API is the problem.
2. **`backup.sh` can go either way, but a shell path must always exist.** There is ALWAYS a way to
   create a backup even if node/API is broken. A thin API wrapper is fine for the common case, but
   if the API is unavailable the bash side must still produce a valid, restore-compatible backup.
   Either fully standalone (preferred, symmetric with restore.sh) or an API wrapper with a
   `--standalone`/`--offline` mode. The standalone capability is non-negotiable.
3. **Single source of truth for the include list.** The set of captured files must come from ONE
   place both `backup.js` and the bash side read. Recommended: a shared JSON such as
   `scripts/backup-paths.json`, parsed by bash with the jq-or-sed fallback pattern
   `scripts/lib/preflight.sh` already uses for `requirements.json`. Alternative: a sourceable
   `scripts/lib/backup-paths.sh` defining `BACKUP_INCLUDES=(...)`. Either way add a test that
   asserts the two sides agree; a diff means one side forgot a new path.
4. **Manifest format parity.** `cidrella-backup-manifest.json` carries type, cidrella_version,
   schema_version, created_at, includes. `restore.sh` must parse it and enforce the same gates as
   `backup.js:restoreBackup()`: refuse `cidrella_version > APP_VERSION`, refuse
   `schema_version > max_migration_in_code`, and allow legacy manifest-less backups best-effort.
5. **The same database copy.** `backup.js` archives a compact copy (`VACUUM INTO`, so the
   `-wal`/`-shm` siblings are unnecessary) with the blocklist feed domains dropped and each
   category's fetch state cleared (`writeBackupDatabase`, `dropFeedDomains`). The bash side must
   produce the same: `sqlite3 ... "VACUUM INTO"` and the same deletes, or the two backups differ
   in size and in what a restore refetches.
6. **Pre-restore snapshot.** `backup.js` snapshots to `/var/lib/cidrella/snapshots/pre-restore/`
   before applying. `restore.sh` must too: users expect the same undo affordance from either tool.
7. **Retention policy.** `backup.js` enforces retention via the `backups` SQLite table. A
   standalone `backup.sh` must either update that table via the sqlite3 CLI (simpler, but adds a
   second DB writer outside the node process, so mind WAL conflicts) or write a sentinel the server
   syncs on next startup (decoupled).

8. **Ask about DHCP, the way the UI does (added 2026-09-19).** The web restore requires the
   operator to choose whether the appliance serves DHCP after the restart and stamps
   `dhcp_enabled` into the staged database before the swap (`stampRestoredSettings` in
   `utils/backup.js`, `?dhcp=enabled|disabled` on the route). `restore.sh` must do the same:
   prompt on a TTY, or take `--dhcp enabled|disabled` (and refuse to guess without a TTY), and
   write the same `settings` row with sqlite3 before moving files into place. A restored copy of
   another appliance must never come up serving that appliance's pools. The same helper also
   inserts the restore's `audit_log` row into the staged database (the running database's row
   is replaced by the restore), so `restore.sh` must write one too, attributed by username.

### Dependency removal transition safety

Learned the hard way in v0.4.7 (2026-04-13): removing a native dependency breaks OLDER `update.sh`
scripts that hardcode binding-existence checks. v0.4.6's updater had:

```
[ -z "$(find "$TARGET_SLOT/server/node_modules/bcrypt/lib/binding" -name '*.node' 2>/dev/null | head -1)" ] && MISSING="$MISSING bcrypt"
```

When v0.4.7 dropped bcrypt for bcryptjs the directory vanished and v0.4.6 refused to upgrade,
requiring a hot-patch of `/opt/cidrella/update.sh` on every v0.4.6 install.

**When a release removes a native module:** ship a stub
`server/node_modules/<removed>/lib/binding/legacy-shim.node` for at least one transition release so
the old `find ... -name '*.node'` check passes. It is never loaded, since no code imports the
removed module. The cleaner long-term fix, making the check read a `runtime-manifest.json` from the
tarball, needs the OLD updater to already be manifest-aware, which is chicken-and-egg, so the stub
stays the practical answer.

### Runtime binary transition caps gotcha

Also from v0.4.7: the preflight probe spawns the new Node directly via `sudo -u cidrella env ...`,
which does NOT inherit `AmbientCapabilities` from `cidrella.service`. So the probe runs with ZERO
caps. Anything requiring `CAP_NET_RAW`/`CAP_NET_BIND_SERVICE` in the deep health check will fail
there and refuse the update, even though the real service would have had the capability.

### Runtime bundle shrink

v0.4.8 stripped `include/`, `share/doc`, `share/man`, `share/systemtap`, `corepack`. Remaining fat
is `lib/node_modules/npm` (~10MB), removable IF `install.sh`'s `npm install` fallback is also
dropped (obsolete since v0.4.3). Deferred until there is user pressure on release size; the current
~85MB is tolerable.

---

## Closed as WON'T-DO

Recorded so they are not re-raised.

From the 2026-07-23 backlog-resolution pass:

- **`cidrella-bootstrap-update` entrypoint.** The self-bootstrap handoff shipped in v0.4.15 works,
  and `min_from: "0.4.15"` closes the pre-bootstrap-fleet path. A second entrypoint is added
  attack and maintenance surface with no remaining consumer.
- **Folding proxy in-memory cache reloads into the after-commit registry.** The registry is
  post-response/microtask while the bypass path requires a synchronous apply. The two timing
  contracts are intentional, and now documented at the bypass writers.
- **A centralized `reqTag()` log helper.** `sanitizeForLog` is already the single barrier, and
  re-touching the CodeQL-annotated sites would reset alert fingerprints for zero security gain.
- **A single page-level Save for `DNS.vue`.** The card-scoped saves map 1:1 to three endpoints;
  a merged Save needs partial-failure UX that is worse than the problem it solves.
- **DoT TLS session resumption.** Measure first: the module is slated for possible replacement by
  a real recursor.
- **Deduplicating `ipToLong`** (`utils/ip.js` vs `url-guard.js`). Deliberate security-boundary
  isolation.
- **Sharing the client-side schedule vocabulary** (`Blocklists.vue` `scheduleOptions`). Separate
  package with no shared-module seam. The server side is single-sourced (`SCHEDULE_HOURS`).

Resolved while consolidating, recorded so they are not re-raised as open:
- **`recursion-dns-default.png` at repo root** (resolved 2026-08-19). No longer tracked.
- **"Harness `upgrade-path` has never executed"** (resolved 2026-08-19). It has now run many
  times against published pre-releases, including the 0.4.16 -> 0.4.17-pre.2 jump.
