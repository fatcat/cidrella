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

These cannot be fixed on `dev/0.4.17` because the files live on `ipv6-phase0`. They land on
`dev/0.5.0` after that branch merges.

### `parseV6` accepts a dotted-quad before `::`

`server/src/utils/address.js`. RFC 4291 permits an embedded IPv4 literal only in the trailing
two hextets. Verified against the real code: `canonicalizeIp('1.2.3.4::')` returns `'::102:304'`,
identical to the correct `'::1.2.3.4'`, instead of `null`. Cause: after the v4 tail is sliced off
`parts`, the double-colon fill still splits on the ORIGINAL `headParts.length`.

**Not reachable today.** `cidr-match.js` calls `parseIp` with `STRICT = { embeddedV4: false }`,
which short-circuits before this path, and it is the only production caller. It becomes reachable
the moment the IPAM side starts parsing v6, which is **IPv6 Phase 1**.

Fix with a test for v4-before-`::`, which no existing test covers.

### `client/vite.config.js` `server.fs.allow: ['..']` needs narrowing, not deleting

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

**Proposed fix**: `fs: { allow: ['.', '../server/src/utils'] }`. Verify by actually starting
`npm run dev:client` after the change: if `fs.allow` replaces rather than extends the implicit
project-root grant, the client root entry is load-bearing. A build will not exercise this.

### Duplicate-logic audit #3

Deferred by dependency, not stuck. Needs the shared-module seam that is IPv6 Phase 0. Detail in
`REVIEW.md`.

---

## Open defects

Both LOW. Neither blocks a release.

### `dns-proxy.js` `evaluateResolvedPolicy` can name a non-blocked country

On a mixed answer set (one blocked-country IP among clean ones), `countryCodes` carries every
looked-up code, so hit counting and the logged `blockReason` (first code) can name a country that
was not the reason for the block. Faithful to pre-refactor behavior on both transports, and
pinned + documented in `dns-proxy-policy.test.js`.

Fix: filter `countryCodes` to the codes `shouldBlock` actually matched.

### `after-commit.js` `regenerate_dnsmasq_conf` restarts dnsmasq unconditionally

Fine for request-driven mutations, where the config nearly always changed. It could adopt the
writers' `changed` return value for restart-only-on-diff, the way boot already does.
A follow-up, not a defect.

---

## Deferred design work

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
