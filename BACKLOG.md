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

### Workspace UI implementation (0.5.0), in flight

Spec: [docs/WORKSPACE-UI-IMPLEMENTATION-PLAN.md](docs/WORKSPACE-UI-IMPLEMENTATION-PLAN.md).
Progress is tracked here by work ID, as the plan asks. The plan is the contract, not a status
board. Phases are the plan's section 13 rows.

**P0, P1: landed** (branch `dev/0.5.0`):
- B-01 permission projection: `9decf97`.
- B-02 workspace reads, plus the `/dns/zones` and `/dhcp/scopes` filter extensions: `391ef9d`.
- B-03 address filters, `/subnets/:id/ips/:ip`, `/subnets/:id/summary`: `391ef9d`, tidy-up
  `32ee098`. Two shipped values changed on the way: `/dhcp/scopes/:id/addresses` reports an
  inactive retained lease as `lease_status: 'offline'`, not `'expired'`; and the
  `/subnets/:id/ips` range filter is `network_range_type_id` (the user-owned tag), no longer
  `range_type_id`, with a new `allocation_source_type` filter beside it (`f426db5`).
- Client wiring to the new reads, `useWorkspaceContext` codec, `useWorkspaceResources`,
  column catalog: `cec372b`. The pre-commit diff review timed out on that one (156 KB diff),
  so it landed on tests and lint alone.
- W-01 extraction into the section 5 boundaries: `fc25654`. `ResourceExplorer`,
  `WorkspaceContextHeader`, `WorkspaceToolbar`, `WorkspaceTable`, `AddressGrid`,
  `WorkspaceDetailsHost`, `workspace.css`. Proven DOM-identical to the pre-extraction render
  across nine states and CSS round-tripped declaration for declaration. Eight dead selectors
  dropped. Nine primitives (`.button*`, `.eyebrow`, `.icon-button*`, `.sr-only`) are duplicated
  into each scoped consumer; if a third consumer appears they move to
  `client/src/components/workspace/` per section 5.
- Section 5 `ipLifecycleEvents.js` shared helper: `ba194c4`, scope-membership labels and actor
  suffix `0487f77`.
- W-02, W-03, W-06 read side, P1 exit scenarios: `f426db5`. URL-backed zone and scope drill-ins
  (T-01..T-03), explorer/table search agreement (T-04), stale-response guard (T-06), details
  survive paging (T-07), save-ok/refresh-failed with read-only retry (T-08), subdivided
  unallocated parents as disabled containers (T-11, `ResourceExplorerNode`), write-control matrix
  (T-32), deleted-context recovery (T-34), Back/Forward (T-42). IPv6 strings never reach the
  IPv4 CIDR helpers in `workspace-view.js`.
- P0 exit evidence still open: baseline screenshots in `screenshots/` need working dev
  credentials and a free browser.

**P2..P5 first pass, landed** (`9545bb8` server, `0487f77` client). No control raises the
"still available in the Current interface" notice any more.
- B-04 `POST /subnets/configuration-preview`, B-05 `entity_id` on `GET /audit`: `9545bb8`.
  `NetworkDialogs` consumes the preview while the operator types.
- W-04, A-02, R-02: one selection model (`useWorkspaceSelection`) across table and both grids,
  exact contiguous runs, gaps never filled. Grid keyboard: roving tabindex, Arrow/Home/End,
  Enter, Space, pointer drag, row context menu.
- A-01, A-04, A-05, A-08, R-01: `IpReservationEditor`, `AddressScanDialog`, `RangeEditor`,
  `RangeTypeDialog`, `BulkActionDialog`, `BulkRangeTypeDialog`. Bulk allocation is sequential,
  stops on first failure, retries only failed runs. Details panel has Overview/Lifecycle/Device
  tabs, 100/500 lifecycle reads, fingerprint override/reset/history.
- N-* first pass: `NetworkDialogs` reused for folder create, allocate/configure/edit/divide/
  deallocate/delete, move to folder, apply defaults. `FolderManagerDialog`. Scan now is live.
- A-03, D-01..D-03, H-02..H-06, R-03: `DnsPanel`/`DhcpPanel` `dialogs-only` mode exposes the
  production editors; middle-of-pool removal explains it is unsupported.
- O-01: `ApplyStatusBanner`, permission-gated DNS/DHCP apply, separate derived-state repair.

- W-05 action registry: `166ce00`. 49 entries in `workspace-actions.js`, handlers in
  `composables/useWorkspaceActions.js`, `targetForRow` keyed on the row-id prefix, menus derived
  by `menuActions`. No label dispatch remains. Three deliberate changes: per-entry capability
  gating (a DHCP-only operator sees DHCP entries on address rows), the header Actions menu only
  targets a network in network context (All Networks used to offer Delete network against the
  default `selectedNetwork`), and DNS record creation needs a resolvable zone (saving without one
  crashed in `DnsPanel`). `NetworksWorkspace.vue` 2,622 to 2,237 lines.

- W-06 details identity: `9ac4359`. `detailIdentity` plus `detailFallback`, `selectedRow` is a
  computed preferring the live page row, `resolveDetail()` re-reads the pinned resource after
  every load (addresses via `/subnets/:id/ips/:ip`, DNS records and DHCP addresses via the
  workspace lists filtered by zone/subnet and `table_q`, matched by id). Only a server "gone"
  closes the panel.
- W-05 overlay rules and T-38 keyboard: `50deafa`, `144b147`. Measured against the real OpenVue
  Dialog: one Escape closes every stacked dialog and drops focus to body. The workspace's own
  stacked dialogs now disable close-on-escape while something sits on top; `useDiscardGuard` +
  `DiscardPrompt` keep dirty forms from closing silently (second dismissal closes). Menus focus
  their first item, take arrow keys, return focus to the recorded invoker. Table rows and grid
  cells reach the row menu from Shift+F10/ContextMenu; rows take Enter/Space/arrows.

- Section 7 mutation and refresh contract: `2429cde`. One `refreshAfterMutation(kind, message)`
  with a table of shared reads per mutated resource (tree, network inventory, zones, scopes,
  apply status); the visible context and pinned details are always re-read; the old subnet
  store's detail cache is dropped and `ipam:stats-changed` is dispatched. Fixed on the way:
  zones and scopes were never re-read after DNS/DHCP changes from network context, scope counts
  stayed stale after IP Reservations, network mutations reloaded the whole workspace and
  re-expanded every folder. Auto-refresh shares the path. Saved-but-refresh-failed keeps the
  page and offers Retry for the read only.
- N-07 merge selection, N-08 bulk apply defaults, N-01/N-05 folder entry points: `selection`
  menu in the registry (`network-selection` and `address-selection` targets, unavailable entries
  kept with their reason so the bar can say what to deselect); `network.merge` left the header
  Actions menu, where it could never see a selection. `folder` target kind: explorer folder rows
  get a menu button, right-click and Shift+F10, the folder context header targets the folder,
  and `Allocate network` from either creates the root in that folder. Explorer folders now keep
  `description`, so Rename no longer blanks it (FolderManagerDialog had the same bug).

- Reused editor overlay rules: `e76d557`. NetworkDialogs (folder, address space, network,
  divide), DnsPanel (zone, record), DhcpPanel (reservation) and ScopeDialog snapshot their form
  on open and ask before a dirty close from Cancel, X or Escape; the network editor keeps Escape
  off under its inline folder editor. Preview-written server defaults move the baseline after
  the gateway watchers run, so an untouched form still closes silently.
- D-06/H-06 settings links and apply entries, W-03 explicit counts, small-screen explorer:
  `68626bb` and the D/H commit below.
- N-04/N-06/N-10 dialog branches: T-10 resume configuration on the created root ID (no second
  root), T-15 execute with the reviewed plan token, 409 `stale_plan` replaces the plan and
  requires a new review with no automatic resubmit (the store used to re-preview behind the
  operator's back), N-10 delete/deallocate report the server's `action`. Save errors show inline.
- D/H edge cases: T-21 `dnsRecordPayload` sends only the fields a type owns (zero kept, empty to
  null), T-23 a created range stays selected so the retry creates only the scope, T-24 multi-pool
  scopes list every interval and lock the bounds so a save cannot drop pools, T-26 reservation
  conflicts stay in the form with the server's reason, T-27 option 51 is never offered beside
  lease time. T-20 convergence is the server's `network-dhcp-*` and `ip-lifecycle` suites plus
  the section 7 refresh; T-22 zone deletion already discloses the record count and needs the
  typed DELETE; T-25 middle-of-pool removal explains it is unsupported (first pass).

- W-07 responsive and accessibility pass, verified in a rendered browser (Playwright, throwaway
  `DATA_DIR`), evidence in `screenshots/W07-EVIDENCE.md`: open details now take a column from the
  work surface at 1024px and up and flow after it below (scrolled into view on pin) instead of
  covering the context actions, toolbar and pager; the toolbar and health gauges wrap; the view
  tabs are a real tablist; the workspace no longer nests a `main` in the app's `main`. Measured
  clean at 1440/1280/1024/768 and 200% zoom, light theme, maximum font bump, modal Save in view.
- P6 gate on 2026-09-16 at this commit: server 100 files / 1127 tests, client 54 files / 362,
  lint, format check, DB ownership check, production client build, all green. The old interface
  stayed at `/networks` and the workspace at `/networks-preview` until the P10 cutover below.

- N-08 drag/drop move to folder: explorer network rows and networks-table rows are drag
  sources (`application/x-subnet-id`, the payload the current interface uses), explorer folder
  rows are drop targets, the drop runs the same `PUT /subnets/:id {folder_id}` the row menu's
  editor uses and then the network refresh contract. Same-folder drops are no-ops, drags without
  the payload never highlight a folder, and nothing is draggable without `subnets:write`. Both
  paths verified in Chromium against a throwaway `DATA_DIR` (`screenshots/n08-drop-target.png`).

- T-20 rendered across both orders (DNS first on one address, DHCP Reservation first on
  another) through the workspace editors against a throwaway `DATA_DIR`, evidence in
  `screenshots/T20-EVIDENCE.md`: one canonical owner per address, the second protocol excluded
  with the server's reason inline, rename/disable/delete reflected in details and generated
  files. Found and fixed on the way: a disabled DHCP Reservation released an address it did not
  hold on edit and delete, so once DNS had claimed the address the lifecycle service refused
  with a 409 and the disabled row could not be deleted (`dhcp-reservation.js`, four model tests).

**Partial:**
- W-07: the long network title wraps word by word beside the action group at 1280 and below;
  readable, not pretty. Not a clipping or reachability defect.

**P7 in flight:**
- Settings workspace shell, `views/settings-workspace/SettingsWorkspace.vue` at
  `/system-preview` (thin `SettingsWorkspacePreview.vue` wrapper, per the preview convention).
  The `settingsAreas.js` catalog drives an explorer of grouped areas with search, a context header
  with an "Appliance-wide" chip when opened from a network (`?return=`), a real section tablist
  (arrow keys, Home/End, `aria-controls`/`aria-labelledby`), and the existing leaf editors mounted
  unchanged in the work surface, so every current function and `?area=&sec=&return=` deep link is
  retained by construction; legacy `?tab=` bookmarks translate as on `/system`. Rendered at
  1440/1024/768 (`screenshots/p7-shell-*.png`): no page overflow, one `main`, fill editors
  (DHCP scopes) scroll inside the panel. **User decision 2026-09-17: the settings workspace is
  good as it stands.** The S-01..S-10, S-16/S-17 leaf editors stay mounted unchanged; no restyle
  is planned. P7 is closed on that basis.

- Workspace chrome (user request 2026-09-16, `aef2319`): the preview banner is gone from the
  networks and settings workspaces; the Interface select (Current / Workspace 0.5.0) and the
  small-text sizer live in the header user menu via `composables/useWorkspaceUi.js`, and the IP
  Management and Settings nav links follow the interface preference. G-01 keeps this.
- User decisions 2026-09-16 (evening): the details panel is a popover over the work surface
  again, nothing under it resizes (reverses the W-07 reflow; the clipped Add button and pager
  under an open panel are accepted); the workspace accent follows the theme's primary color
  instead of a fixed teal; table page sizes are 32/64/128/256/512 (server caps raised to 512);
  the paginator is always visible; loading is a popover over a blurred, dimmed table.
- User decisions 2026-09-17: the DNS tab opens on the forward zone by default and on the
  remembered side after that (the mixed record list sorts by FQDN, so its first pages were all
  PTR records and read as the reverse zone); only the active zone or scope chip is drawn as
  selected; DNS record rows lose "Open IP details" and "Open whole zone"; the per-row three-dot
  button is gone from every table, right-click and the ContextMenu key are the two ways in.
- User decisions 2026-09-17 (later): DHCP address rows lose "Open IP details" and "Open scope"
  (`ip.open` is gone from the registry) and gain "Edit Scope" when inside a scope; DNS record rows
  gain "Edit zone"; right-clicking a linked zone or scope card in the context header opens that
  zone's or scope's menu (edit, delete, add record/reservation). The allocation rule the user
  stated now gates the registry: divide and merge apply only to unallocated leaf networks, an
  allocated network is deallocated first; Merge on the selection bar says why it is disabled
  (allocated, root, different parents, divided, or not one CIDR block) instead of letting the
  server preview fail with "All subnets must be siblings". Network rows and explorer rows carry
  the full network menu (allocate/edit, divide, move, apply defaults, deallocate, delete, scan).
  The create menu says "Create network"; an unallocated row says "Allocate network". Server
  note: deallocation deletes a network's DHCP scopes and IP rows rather than disabling them.

**P10 cutover: landed 2026-09-17** on the maintainer's call, IP Management first (`4cecb70`),
Settings the same day. `/networks` and `/system` are the workspaces; `/networks-preview` and
`/system-preview` redirect there keeping query and hash; the classic views are at
`/networks-classic` and `/system-classic`, reached from a "Classic interface" pair of links in
the header user menu. The Interface preference is gone (`useInterfacePreference` removed,
`CLASSIC_PATHS` in `useWorkspaceUi.js`). `client/tests/unit/router-cutover.test.js` covers the
routes. The legacy bookmark redirects (`/dns`, `/dhcp`, `/blocklists`, `/geoip`, `/range-types`)
already pointed at `/system?area=...`, which the shell reads. Removing `SubnetsLayoutB.vue`,
`Settings.vue` and the rest of the classic views is the separate follow-up the plan names, after
practical validation; the `*WorkspacePreview.vue` file names keep their suffix until then.

**P8, appliance and account workflows: landed 2026-09-17.** The S-11..S-15 editors (backup,
updates, logs, import, users, certificate) were already mounted unchanged in the settings shell,
so P8 was a verification pass on safe fixtures plus two fixes:
- Verified on the dev box: all six sections render at `/system?area=...&sec=...` with their
  controls and no console errors.
- Verified on a throwaway backend (scratch `DATA_DIR`, ports 8444/8081, killed afterwards):
  first login with the seeded admin, forced password change, landing, the workspace's empty
  estate, first network created through Create network (one `POST /subnets` plus one configure
  call, the explorer row within 300 ms, a reload issues only reads: T-39); backup created and
  deleted through the UI (file gone on disk); Reset Database needs the typed RESET (confirm
  disabled until then); Check Now sends only `POST /version/check`, never install; Pi-hole import
  probe of a blocked address shows the error, Connect stays disabled, nothing written, the
  password is not kept across navigation or in storage; CSR generated without any private key
  reaching the page or storage; an invalid certificate pair is rejected client-side with the
  fields kept and the certificate unchanged; a created user's one-time password is gone from the
  DOM and storage after Done. Dev tracking is compiled out of production builds
  (`VITE_TRACKING`), so nothing tracks those pages there.
- Fix: `Users.vue` clears the revealed password and token when their dialogs close
  (`client/tests/unit/views/UsersSecrets.test.js`, mutation-checked).
- Fix (G-01): `HeaderBar.vue` shows a failed `/health/system` read as unavailable (chips read
  the empty cell with an Unknown dot, the popover says Unavailable/Unknown) instead of CPU 0%
  and a healthy dot; a stale good reading is dropped on the next failed poll
  (`client/tests/unit/components/HeaderBarHealth.test.js`, mutation-checked).
- S-18 finding: `SetupWizard.vue` has had no route since v0.4.0 (`ac734e2`); a fresh database
  seeds the admin, so `/api/setup/status` always answers `setup_required: false` and the
  wizard can never show. First run is login, forced password change, then the workspace. The
  file is dead code and is left for the classic-file removal follow-up.
- G-02 unchanged: login redirect sanitizing and last-view landing are covered by
  `client/tests/unit/utils/landing.test.js`; the workspace URLs pass through it.

**P9 in flight (2026-09-17):**
- Analytics shell (Q-01..Q-03 shell level, the saved 2026-09-15 patch applied): the section
  nav is keyboard-operable buttons with `aria-current`, the open section lives in the URL as
  `?view=dashboard|performance|intelligence|anomalies` so bookmarks and Back work, unrelated
  query parameters survive, and the old `cidrella_analytics_tab` index is still read and written
  (`client/tests/unit/views/Analytics.test.js`). The Dashboard, Performance and Intelligence
  panels are mounted unchanged, the same call as P7's leaves.
- Q-04 anomaly triage, DEFERRED 2026-09-17 by the user: both views stay as they are, the
  current Anomalies panel at `/analytics?view=anomalies` and the concept at
  `/anomalies-preview` (sample and live modes; nothing links to it since the banners went, so
  the URL is the way in). The merge of elements from each is decided on a system with real
  anomaly data; the dev box only has learning-baseline clients, so the current view shows
  nothing to judge by. Screenshots of both as of today: `screenshots/p9-anomalies-*.png`.
  Element inventory of each is in the session notes of that date.
- Setup wizard revival is a user want for later, recorded in TODO.md, not part of P9.

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
