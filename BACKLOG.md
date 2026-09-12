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
- `REVIEW.md` (untracked): the review-agent ledger, including per-commit history. Findings
  that stay open past their review graduate to here.

Consolidated 2026-08-19 from four places that had drifted apart: `REVIEW.md` Active Findings,
`PLAN.md` "Backlog (deferred)", `docs/SESSION-STATUS.md` "Next Resume", and the memory
`project_*` files.

---

## Blocked on a branch

**This section is empty as of 2026-09-12.** The files are all present on `dev/0.5.0` now, so
nothing here was still blocked. Two items were fixed and one moved to design work below.

### ~~`parseV6` accepts a dotted-quad before `::`~~ [FIXED 2026-09-12, `a6e7537`]

`server/src/utils/address.js`. RFC 4291 permits an embedded IPv4 literal only in the trailing
two hextets. Verified against the real code: `canonicalizeIp('1.2.3.4::')` returns `'::102:304'`,
identical to the correct `'::1.2.3.4'`, instead of `null`. Cause: after the v4 tail is sliced off
`parts`, the double-colon fill still splits on the ORIGINAL `headParts.length`.

**Not reachable today.** `cidr-match.js` calls `parseIp` with `STRICT = { embeddedV4: false }`,
which short-circuits before this path, and it is the only production caller. It becomes reachable
the moment the IPAM side starts parsing v6, which is **IPv6 Phase 1**.

**[FIXED]** Guarded on `hasDoubleColon && tailParts.length === 0`, the exact "quad came from
the head with a `::` after it" case. Four tests added, including one asserting the malformed
form no longer canonicalizes onto the valid one, and one walking the legitimate spellings
(`0:0:0:0:0:0:1.2.3.4` has no `::` at all, which is what stops the guard being written as the
simpler, wrong tailParts-only check). Mutation tested 3 ways.

### ~~`client/vite.config.js` `server.fs.allow: ['..']` needs narrowing~~ [FIXED 2026-09-12, `fb9f50a`]

Validated 2026-08-18, and two earlier guesses about it were wrong in opposite directions.

**It IS dev-only**, confirmed three ways rather than assumed: `server.*` applies only to the Vite
dev server; `build-release.sh` copies only `client/dist` so the config never ships; production
serves the SPA via `express.static` with no Vite process.

**But it is NOT redundant and must not simply be deleted.** Asked Vite directly:
`searchForWorkspaceRoot(client/)` returns `client/`, not the repo root, because
`client/package-lock.json` short-circuits the walk up. So the default grant is `client/` alone and
the `@shared` alias (resolving to `../server/src/utils`) would be refused. **Deleting the line
breaks `npm run dev:client`.**

**The exposure is larger than first logged.** Root `package.json` runs `dev:client` as
`vite --host`, binding every interface. While a dev server is up, anyone who can reach the port
can fetch `/@fs/<repo>/server/data/cidrella.db` (6.4MB). `.buildignore` excludes `/data/` from
releases precisely because it leaks dev credentials and audit log contents.

**[FIXED]** Applied exactly as proposed, `fs: { allow: ['.', '../server/src/utils'] }`. The
exposure was confirmed live first, not assumed: `GET /@fs/<repo>/server/data/cidrella.db`
returned HTTP 200 and all 6,717,440 bytes. After the change the database, root `package.json`,
`.git/config` and `server/src/index.js` all return 403 while `server/src/utils/address.js`
still returns 200 and the app runs. The client root entry IS load-bearing, as suspected.

### Duplicate-logic audit #3: the `ip.js` cross-tier pair

**No longer blocked, but it is design work, not a quick fix.** The shared-module seam it waited
on exists and works: `client/shared-modules.js`, the `@shared` alias wired into both
`vite.config.js` and `vitest.config.js`, and `client/tests/unit/utils/shared-address.test.js`
passing.

**Recovered 2026-09-12 and written down here because it was nearly lost.** `REVIEW.md` is
gitignored and the review agent prunes resolved findings, so the numbered audit entry for #3 is
gone. Memory recorded only its number and bucket. The surviving description is one line at
`REVIEW.md:1011`: #3 is `ip.js`, one of the cross-tier pairs that **already diverge**, alongside
#1 (ip-view) and #5 (scan-coverage). The same line gives the constraint that matters: diverging
pairs "are NOT candidates for a lock-it-down test: fix them first, then lock."

So the work is to reconcile the pair per the three-strategy rule in
`docs/CROSS-TIER-DUPLICATION.md`, then add a differential test. **This touches address
classification, so the canonical IP model gate in `AGENTS.md` applies before any change.**

---

## Open defects

All LOW. None blocks a release. **All three resolved 2026-09-12**, one of them found to have
been fixed already.

### ~~Four hover backgrounds never render, `--cid-surface-hover` is undefined~~ [FIXED 2026-09-12, `d5bfea3`]

Found while building the token shim in Phase 0b. The widget library never defined
`--p-surface-hover`, so the alias does not exist and it computes to empty in all 6 themes.
Confirmed in the browser, not inferred.

Four call sites read it bare, with no fallback, so each declaration is invalid at
computed-value time and the background simply does not paint:
`LogViewer.vue:242`, `GeoIP.vue:473`, `DebugPanel.vue:137` and `DebugPanel.vue:247`.
Those hover states have been doing nothing for as long as the token has been referenced.

Fix is one line in `client/src/ui/tokens.css`, aliasing `--cid-surface-hover` to
`--p-content-hover-background`, which is the v4 name for the same thing and is defined in every
theme. Held back deliberately: Phase 0b's rename commit is in `.git-blame-ignore-revs` and had to
stay purely mechanical, and this changes rendering.

**[FIXED]** Aliased to `--p-content-hover-background`, the v4 name for the same thing. Verified
across all 6 themes: it resolves everywhere, matches its source, and is distinct from the card
colour it sits on, so the hover is visible rather than merely defined.

`--cid-surface-content-muted` was dead the same way but harmless, since both call sites in
`NetworkDialogs.vue` supplied `var(--cid-text-muted-color)` as a fallback. They now read that
directly and the dead name is gone.

### ~~`dns-proxy.js` `evaluateResolvedPolicy` can name a non-blocked country~~ [FIXED 2026-09-12, `f58ba45`]

On a mixed answer set (one blocked-country IP among clean ones), `countryCodes` carries every
looked-up code, so hit counting and the logged `blockReason` (first code) can name a country that
was not the reason for the block. Faithful to pre-refactor behavior on both transports, and
pinned + documented in `dns-proxy-policy.test.js`.

**[FIXED]** `shouldBlock` became `blockingCountryCodes`, returning the matching subset instead
of a boolean, and the caller narrows both `countryCodes` and `blockReason` to it. The empty-
ruleset special case folds into the filter rather than being branched on.

The real cost was analytics, not the log line: `countryCodes` feeds `recordResolvedBlock`, which
increments per-country hit counters, so clean countries were accumulating blocks they never
caused. The test that pinned the old behaviour now asserts the correct one. A follow-up
(`739ada9`) fixed a weakness the review caught in the new test: the multi-country case passed CN
twice rather than two distinct blocked countries, because RU's only fixture IP sat inside the
allowlisted `/24` and could never reach the lookup.

### ~~`after-commit.js` `regenerate_dnsmasq_conf` restarts dnsmasq unconditionally~~ [ALREADY FIXED]

**Stale entry, verified 2026-09-12.** It already does restart-on-diff and has since `88b1ec5`.
`regenerateDnsmasqConf` returns `writeIfChanged(...)`, a boolean, and the hook reads
`const changed = withValidatedDnsmasqUpdate(...); if (changed) restartDnsmasq();`. Exactly the
change this entry proposed. Nothing to do.

---

## Deferred design work

### ~~Canonical Network/DHCP transformations~~ [FIXED]

Implemented in the current working tree on 2026-09-09. Disposable-database
tests reproduce stale IP allocations after split, parent router options copied
to child scopes, lease deletion/detachment, and loss of all but one source's
scopes on merge. Equal split and carve also use different gateway policies.

The [Network/DHCP governance plan](docs/NETWORK-DHCP-GOVERNANCE-PLAN.md) records
the evidence, proposed ownership and inheritance contracts, migration safeguards,
implementation phases, and synthetic cross-model regression matrix. It builds
on the canonical IP model without adding a second allocation precedence tree.
Production was not inspected or changed. The adopted policy preserves pool
holes, makes network routing authoritative, and reports ambiguous repairs.

### UI redesign: remaining scope

The left-rail redesign is **partially done**. A granular pass shipped 2026-04-18/19 (all 8 steps
of `redesign_spec.md` plus the Range Map tab, nav font +30%, IP Management left rail) and the
Settings A+C shell shipped 2026-06-09. The app is still top-nav, deliberately.

Remaining:
- **Unified status system** (StatusDot / StatusBadge, one vocabulary:
  `state-ok | state-warn | state-err | state-info | state-idle`, deleting the aliases). This is
  where the 2026-07-23 review deferrals live: WCAG 1.4.1 color-only dots, red-badge-on-warn-chip,
  and rogue yellow/orange drift.
- **Empty states** for every table-backed view.
- **Settings tab-nesting flattening**, plus the PrimeVue `TabView` -> `Tabs` migration.

Note the original design-bundle paths in the memory file point at 2026-04-18 `/tmp` locations
that no longer exist.

### Anomaly identity: full MAC scope (lease history + IP-spanning DNS aggregation)

Migration 055 and the sidecar changes shipped the **minimal** half of this: `anomaly_scores`,
`anomaly_models` and `anomaly_whitelist` are keyed by an `identity` resolved at train/score time
(the MAC from the device's *current* DHCP lease, falling back to the IP when there is none). That
closes the safety-critical bug — a device taking over another host's IP no longer inherits its
learned baseline, and a whitelist entry now survives a renewal.

What it does **not** close: feature extraction is still IP-keyed, because the DuckDB DNS log has
no MAC column — `features.get_client_history_hours()` / `extract_training_data()` /
`extract_features_with_history()` all take a `client_ip`. So when a device renews onto a new IP,
its identity and whitelist carry over but its *observable history* resets, and it drops back to
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
- The header bell badge still counts anomalous *windows*, not distinct clients, so it reads far
  higher than the redesigned Anomalies page's per-client tiles.
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
5. **WAL checkpoint before tar.** `backup.js` runs `db.pragma('wal_checkpoint(TRUNCATE)')` so the
   main `.db` is complete and the `-wal`/`-shm` siblings are unnecessary. The bash side must do the
   same, or copy the siblings alongside.
6. **Pre-restore snapshot.** `backup.js` snapshots to `/var/lib/cidrella/snapshots/pre-restore/`
   before applying. `restore.sh` must too: users expect the same undo affordance from either tool.
7. **Retention policy.** `backup.js` enforces retention via the `backups` SQLite table. A
   standalone `backup.sh` must either update that table via the sqlite3 CLI (simpler, but adds a
   second DB writer outside the node process, so mind WAL conflicts) or write a sentinel the server
   syncs on next startup (decoupled).

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
