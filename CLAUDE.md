# CIDRella

IP Address Management (IPAM) appliance with DNS and DHCP via dnsmasq. Single-box deployment:
Node.js 24 + Express 5 + better-sqlite3 on the backend, Vue 3 + PrimeVue v4 + Pinia + Vite on
the frontend, dnsmasq managed alongside. Ships as a signed release tarball installed natively
(systemd, A/B slots) or via Docker.

The agent instructions every coding agent shares (the canonical IP model gate, IPv4 and IPv6,
repository workflow) live in AGENTS.md, imported here so Claude Code loads them every session:

@AGENTS.md

## Layout

- `server/`: Express API, SQLite models, the DNS/DHCP backend layer (`src/backends/`: registry,
  contract, and the dnsmasq adapter in `backends/dnsmasq/`), DNS proxy. Entry:
  `server/src/index.js` (prod boots via `server/src/launcher.js`).
- `client/`: Vue 3 SPA. Built output is served by the server.
- `scripts/`: install/update/rollback, release build (`build-release.sh`), systemd units,
  integration test harness (`test-harness/`).
- `docs/`: architecture and feature docs. `docs/SESSION-STATUS.md` is the canonical
  project-status document; `PLAN.md` tracks phases; `RELEASE-NOTES.md` per release.

## Testing

Run from the repo root (the scripts handle the `cd` into each package):

```bash
npm test               # full suite: server then client
npm run test:server    # server unit + integration (vitest)
npm run test:client    # client unit (vitest)
npm run test:sidecar   # anomaly sidecar rules (python3 unittest, stdlib only, no venv needed)
npm run lint           # ESLint (flat config, correctness-focused), must exit 0
npm run build:client   # production client build, a build failure is a test failure
npm run check:reuse    # duplicate helpers, duplicate scoped CSS, hand-built confirm dialogs (baselined)
npm run hunt:workspace # 300 seeded random walks through the Networks workspace (model test)
```

The Networks workspace has a model-based test (`client/tests/unit/views/networks-workspace/model/`,
read its `README.md`). Seeded random walks click through a fake estate and check the screen against
invariants after every step; a failure shrinks to a `walk([...])` for `regressions.test.js`. When
the workspace gains a control or a display rule, add it to `driver.js` or `violations` there.
Components carry `data-row-id`, `data-zone-id`, `data-scope-id`, `data-network-id` and
`data-folder-id` for it; keep them when refactoring, like `data-track`.

Backups have a round-trip test (`server/tests/integration/backup-round-trip.test.js`): export,
change everything, restore, restart, and every table and carried file must match, but for what a
restore promises to change. A new table is covered automatically; a new file or directory under
`DATA_DIR` that backups carry goes in its `CARRIED` list. Server code that reads `DATA_DIR` when it
loads (`config/defaults.js`, so `utils/backup.js`) needs `tests/helpers/isolated-data-dir.js`
imported first in its test file; `setupTestDb` sets `DATA_DIR` too late for it.

CI (`.github/workflows/ci.yml`) runs lint + both test suites + the client build + the
release-version guard on every push to main; CodeQL runs taint-flow security analysis.
Dependabot delivers grouped weekly dependency PRs. Prefer merging those over manual
lockfile bumps.

End-to-end install/upgrade behavior is covered by the integration harness at
`scripts/test-harness/`. Read `manifest.json` first (agent-facing catalog of scenarios),
run via `scripts/test-harness/run.sh`. It wipes the target host between scenarios: only ever
point it at the designated throwaway test host, NEVER production.

## Development

```bash
npm run dev:server     # backend on local data dir
npm run dev:client     # vite dev server (hot reload)
```

Iterate locally; the test LXC is for release-upgrade validation, not day-to-day development.

## Conventions

- **Canonical IP model gate**: before changing IP allocation, address
  classification, hostname selection, reverse DNS, DHCP/DNS synchronization,
  topology projection, migration reconciliation, or related UI display logic,
  follow the mandatory contract and validation rules in `AGENTS.md`. The
  canonical semantics live in `docs/ARCHITECTURE.md`, `docs/API_MODEL.md`,
  `docs/IP-LIFECYCLE-GOVERNANCE-PLAN.md`, and the IP ADRs. Do not introduce a
  second precedence tree outside the lifecycle service and read model.
- **Migrations** (`server/src/db/migrations/`) are numbered and append-only. Number 048 is
  intentionally skipped (burned by an orphan-migration incident). Never reuse it. New
  migrations take the next free number.
- **Data paths** come from the `DATA_DIR` env var (`/data` in Docker, `/var/lib/cidrella`
  native, `server/data/` in dev). Never hardcode them.
- **Architecture**: releases are **linux-x64 only**, arm64 was discontinued after v0.4.15
  (no field hardware to validate bundled native modules on). `build-release.sh` refuses
  other arches; `install.sh`/`update.sh` refuse on arm64 hosts.
- **Versioning**: only the ROOT `package.json` version is release-tracked, and it must match
  the newest `## vX.Y.Z` heading in `RELEASE-NOTES.md` (enforced at build time by
  `scripts/check-release-version.js`). The `server/` and `client/` package.json versions are
  intentionally stale and unread, don't bump them.
- **Release packaging**: `.buildignore` controls tarball contents (rsync exclude rules,
  anchor dev-only patterns with a leading `/`). `scripts/check-staging-imports.js` (import
  completeness) and `scripts/check-release-version.js` (version == release-notes heading) run
  during the build and fail it on violation. Releases are built and signed by the maintainer
  (`scripts/build-release.sh`); signing requires an interactive TTY.
- **Review findings** live in `REVIEW.md` (tracked) until they are fixed; the rules are in
  `AGENTS.md` (Review findings). A fixed finding is deleted in the commit that fixes it, which
  names its ID.
- **Work tracking is split by how far along the work is, and the split is deliberate.**
  `TODO.md` is for things that have NOT begun: an idea, no context yet. `BACKLOG.md` is for
  work IN FLIGHT: started, deferred, or blocked, where thought or code has already been spent
  and there is a blocker, a measurement, or a rejected approach worth keeping. An item
  graduates from TODO to BACKLOG when it acquires that context. `BACKLOG.md` is the ONLY
  backlog: it was consolidated from four scattered locations on 2026-08-19, and `REVIEW.md`,
  `PLAN.md` and `docs/SESSION-STATUS.md` now point at it rather than carrying their own lists.
  Do not start a fifth. `REVIEW.md` lists known issues, not work: a finding moves to
  `BACKLOG.md` only once work on it has started and stalled.
- **Screenshots and throwaway prototypes** go in `screenshots/` (gitignored), never the repo
  root.
- **Shared things exist, use them.** Before writing a component, style rule or helper, check
  this list and grep for the name. Client: every vendor component is imported through
  `client/src/ui/*.js`, never from the package; `EmptyState`, `StatusDot`, `StatusBadge`,
  `AddressTypePill`, `ConfirmDialog` (every danger or warn confirmation, with
  `type-to-confirm` for the typed gates), `ScanToggle` (`inherits-from` names the parent),
  `DiscardPrompt` + `useDiscardGuard`, `AllowlistDialog`, `dns/ResolverPicker` (a resolver choice: preset, custom or none; `utils/resolvers.js`
  describes selections) and `dns/ResolverTestDialog`, `dhcp/DhcpOptionTable` (the DHCP option editor
  table: Settings defaults and Bulk Change; `composables/useDhcpOptionCatalog.js` loads its
  catalog and builds the request body), `networks-workspace/dialogs/RangeTypeDialog`
  + `RangeTypeFields` (the one Network Range Type editor: Settings uses the dialog, RangeEditor
  the fields inline; type writes go through the subnet store so its type cache drops), `WorkspaceHead` (title, lede, Refresh and the range select of a
  reworked Analytics section), `SeriesChart` (every area chart of minute rows, with per-series
  `aggregate` and `summary`; legend chips toggle series), `StackedBar` (a split as one bar with
  a toggling legend; `dashboard/AllocationBar` wraps it), `TopList` (a ranked list with bars,
  every top-10), `dashboard/FigureCard`; `utils/format.js` (`apiError`,
  `formatNumber`, `displayOnlineStatus`, `EMPTY_CELL`), `utils/chart-config.js` (colors,
  `RANGE_OPTIONS`, `rangeLabel`, line and doughnut options), `utils/dateFormat.js`, `utils/keyboard.js` (`MOD_LABEL`, `isModShortcut`: Ctrl, or Command on a Mac, for every shortcut and its hint),
  `utils/proxy-perf.js` (the resolution and process figures from the proxy-perf rows),
  `utils/service-chips.js` (the backend, proxy and forwarder chips), `utils/backend-status.js`
  (`backendUnits`: the DNS/DHCP backends from a health payload, one unit per daemon, with the
  pre-0.5.1 dnsmasq flag as fallback; every chip or row naming a backend reads it), `utils/ipTableDisplay.js`
  (`ipSourceLabel`, the one label for a DNS, DHCP or detection source), and in
  `views/networks-workspace-data.js` the `ipRowFields` adapter that fills every shared IP
  column for the workspace tables (both the Addresses and DHCP adapters spread it; add a
  column there, never in one adapter), and `dnsRecordSummary` (the one wording for the DNS
  records behind an address, disabled ones named). The Addresses, DNS and DHCP tables are ONE
  table model: `networks-workspace/workspace-columns.js` holds the one catalog every one of
  them offers, and `LOCKED` the columns each cannot hide (they reorder); the server attaches
  what the other tables know with `models/ip-row-facts.js` (`dns_record`, `dhcp`). Filtering,
  counting and sorting any column is `utils/ip-columns.js` (one getter per column key; its test
  checks the keys against the client catalog), and the client control is
  `components/table/FilterMenu.vue`; never build filter choices from the rows on screen. Shared styles: `assets/utilities.css` (global, loaded by
  `main.js`: `muted`, `text-sm`, `w-full`, `mono`, `sr-only`, `action-buttons`,
  `dialog-actions`, `card-header`, `field-error`), `assets/analytics-workspace.css` for the
  reworked Analytics sections (head, rail, chip, panel, `.board` with `--board-columns` and
  the `split`/`three` modifiers, `.figures` with `--figures`, `.lists` with `--lists`), `assets/panel-chrome.css` for the
  DNS/DHCP panel info bar and sidebar search, `networks-workspace/dialogs/range-dialogs.css`
  for the range dialogs' form grammar, `assets/analytics-layout.css` for
  the sections not yet reworked, `ui/tokens.css` for `--cid-*`. Server: `utils/validation.js`,
  `utils/ip.js` and `utils/cidr.js`, `utils/dns-names.js` (`fqdnForRecordName`,
  `normalizeRecordNameForZone`, `normalizeDnsName`: the zone-file rule for record names, a
  trailing dot is absolute and anything else is under the zone; SQL that builds an FQDN must
  agree with it), `utils/reverse-zones.js` (`generateReverseName(s)`,
  `reverseZoneNetwork`: the in-addr.arpa and ip6.arpa names for a CIDR and back),
  `utils/config-value-validation.js` (`validateConfigSafeValue` and the record-name and TXT
  checks: what a DNS or DHCP value may contain before any backend writes it),
  `services/ip-lifecycle-service.js` for every lifecycle
  write, `models/ip-events.js` for address history (`ip_events` and `ip_range_events`; history
  is keyed by address, never by row, so it outlives the row), `utils/request-actor.js`
  (`currentActor`, the signed-in user a write deep in a model should name), `models/ip-view.js` for every server-owned display field (status, type, and
  `dhcp_lease_state` from the newest lease; any read that shows an address feeds it
  `in_dynamic_pool` and `dhcp_expires_at` rather than computing its own; a count of rogue
  hosts runs rows through it too), `macIsAuthoritative` in `models/ip-lifecycle.js` (whether DHCP sets an address's stored MAC; anything comparing an observed MAC with the stored one asks it), `isAddressPoolScope` / `addressPoolScopeSql` in `models/dhcp-scope.js` (whether a scope's
  pools hand out addresses: every DHCPv4 scope and a stateful DHCPv6 one, never a SLAAC or
  stateless one; anything treating a scope as a dynamic pool asks it), `backends/index.js` (the DNS/DHCP backend registry: `getDnsBackend`,
  `getDhcpBackend`, `getService`, `backendStatuses` for what the health endpoints report,
  `getDnsBackend().servedTtl(record)` for the TTL a record is answered with: every record read
  carries it as `served_ttl`, and a TTL display shows that, never the stored `ttl`; only `backends/**` imports an adapter, and an adapter never
  writes the database), `services/backend-apply.js` (`applyDns`, `applyDhcp`, `applyResolver`:
  what the after-commit hooks run; `applyAtBoot` and `applyListenNow` for the paths that cannot
  wait for a hook; route and service tests stub them with `stubBackendApply`, or swap the
  registry with `fakeBackendsModule`, both in `tests/helpers/fake-backends.js`; a new adapter
  passes `tests/contract/backend-contract.js`; anything reading the backend's log asks
  `getService(role).logSource()`),
  `services/dhcp-lease-sync.js` (`ingestLeases`, `syncLeasesNow`: every lease sync), `findNeighbor` in `utils/nd-cache.js` (every IPv6 neighbor
  lookup: a link-local address is keyed with its interface, so look it up with one),
  `createUpstreamPool` in `utils/upstream-pool.js` (every encrypted query to a forwarder
  upstream, DoT or DoH: reused connections, retry, address failover, fail closed),
  `plainUpstreams` and `backupMode` in `utils/forwarding-settings.js` (the plaintext primary
  then backup, and On failure or Load balance; nothing else joins the two lists),
  `utils/plain-dns.js` (`plainUdpQuery`, `plainTcpQuery`: one plain query, either family),
  `timeQuery` in `utils/upstream-probe.js` (one timed query over plain, DoT or DoH) and
  `services/resolver-benchmark.js` (the one-minute resolver performance test),
  `failureCause` in `utils/dns-ede.js` (the one place a failed DNS answer gets its cause,
  from the rcode and EDE; the client reads its labels through `@shared`),
  `probeAddress` in `utils/upstream-probe.js` (one real query to one upstream address; the
  health chip and `scripts/check-dns-providers.js` both use it), `forwarderHealth` in
  `utils/forwarder-health.js` (the Forwarders health entries, cached 30 s),
  `createReservoir` / `quantileOfSorted` in `utils/samples.js` (latency samples and their
  percentiles),
  `fillScopeOptions` in `services/subnet-dhcp-topology.js` (the options a scope gets from an
  enabled set, blanks filled from its network; new scopes and Bulk Change; `USE_DEFAULT` there
  marks an option linked to its default, written as a NULL row), `networkOptionFills` and
  `FALLBACK_SECONDARY_DNS` in `utils/dhcp-network-options.js` (what a scope takes from its
  network, either family; the scope dialog imports it through `@shared`),
  `resolveEffectiveScopeOptions` and `isLinkedOption` in `models/dhcp-scope.js` (what a scope
  serves: a default only through a linked row, see ARCHITECTURE.md DHCP option layering),
  `linkedOptionCounts` in `models/dhcp-option.js` (scopes using each default),
  `models/session.js` (every sign-in session rule: idle and 24 hour limits, ending sessions
  with a reason; see ARCHITECTURE.md Sign-in sessions), `models/filtering-exemption.js`
  (every rule for a host with DNS filtering off: keyed by MAC, else address; `exemptAddressSet`
  is what the proxy and the reads both use) and `utils/filtering-pause.js` (the pause periods,
  client through `@shared`), `utils/resolution-feed.js` (the Resolution Map's live event
  buffer; the map never reads the proxy's `getAndReset*` counters) and `utils/geo-cities.js`
  (the city table: coarsening, file format and lookup, shared with
  `scripts/build-geo-cities.js`), client `components/analytics/ResolutionCanvas.vue` (the map and
  globe renderer; its math is `utils/resolution-map-geometry.js`), `utils/country-geo.js` (each
  country's landing point and atlas outline, generated) and `components/GeoAttribution.vue`
  (the DB-IP credit every page showing GeoIP results carries), client
  `composables/useSessionActivity.js` (what counts as activity and the warnings, mounted once in
  `App.vue` with `SessionTimeoutDialog`) and `utils/session.js` (why the last session ended, for
  the sign-in page),
  `isTopologyAddress` in `utils/cidr.js` (is this the network or broadcast address topology
  reserves; nothing on /31, /32, /127, /128), `macFromDuid` in `utils/duid.js`, client
  `utils/ip.js` `dhcpPoolScopeFor` (the pool an address falls in, either family),
  `divideGatewayDefault`, `GATEWAY_POSITION_OPTIONS` and `inferGatewayPosition` (with
  `components/GatewayField.vue`, the one gateway picker: network dialogs and the scope dialog), and in `views/networks-workspace-data.js` `addressCount`,
  `formatAddressCount` (BigInt-safe sizes) and `compareCellValues` (address-aware table sort), `reconcileDnsHold` in the lifecycle service for ADR 004 (a disabled
  record holds its address as `reserved` owned by `dns`; call it after any DNS write that can
  change whether a record is served), `utils/scan-coverage.js` for "will the scanner probe
  this" (`scannerCoveredSql` plus `isAutomaticScanAllowed` for the public-network and IPv6
  gates SQL cannot express; the scheduler and the stale sweep both apply both). Add to this list when you
  make something shared. Five guards enforce what they can detect, each baselined so it fails
  only on NEW instances (fix one by deleting its baseline entry, never by adding one):
  `npm run lint` refuses an import of a backend adapter (`server/src/backends/<name>/`) from
  outside `server/src/backends/` (ESLint for static imports, `scripts/check-backend-imports.js`
  for `vi.mock` and `import()` strings; tests of the adapters live under `tests/*/backends/`), a vendor import outside `src/ui`, a raw `<select>`/`<input>` outside
  the baselined files, and a `dot`/`pill`/`badge` class outside the status components;
  `npm run check:reuse` runs `check-duplicate-exports.js` (a local copy of an exported helper),
  `check-scoped-css-dupes.js` (an identical rule in two scoped style blocks; `--drift` lists
  same-name-different-body candidates as a report) and `check-confirm-dialogs.js` (a Dialog
  whose footer carries its own danger or warn Button instead of using ConfirmDialog; its
  baseline is empty). CI runs all of them.
- **Selection and status marks**: a selected or open item is shown by a 1px outline in the
  accent color plus a soft tint (the explorer's All Allocated Networks row is the model); a
  checked item that is not the open one gets the tint alone. A state (ok, warning, error) is
  shown by a `StatusDot` or an icon beside the text. Neither uses a colored left bar.
- **UI instrumentation**: key UI elements carry `data-track` attributes consumed by the dev
  tracking endpoint. Preserve them when refactoring components.
- **Linting**: ESLint only (`eslint.config.mjs`), correctness-focused. Stylistic Vue rules
  are intentionally off, formatting is Prettier's job and lint does not duplicate it.
- **Formatting**: Prettier (`.prettierrc.json`, pinned exact). Adopted 2026-09-12, reversing
  the earlier no-Prettier rule. The settings were measured off the existing code rather than
  taken as defaults: single quotes (the repo had 708 to zero), `printWidth: 100` (p95 of real
  line length was 94), Vue `<script>` left flush with the tag. Scope is CODE ONLY, `.js`
  `.vue` `.css`. Markdown, JSON, YAML and HTML are in `.prettierignore` so hand-formatted
  prose and machine-parsed files keep the shape their consumers expect, notably the
  `## vX.Y.Z — YYYY-MM-DD` headings that `build-releases-manifest.js` parses.
  - Run `npm run format` to sweep, `npm run format:check` to verify.
  - The reason for the original rule was blame, and that is handled by
    `.git-blame-ignore-revs` instead. Git uses it via
    `git config blame.ignoreRevsFile .git-blame-ignore-revs`, GitHub honors it with no
    config. Only add purely mechanical commits to that file.
  - Adopting it is all-or-nothing on purpose. The global format-on-edit hook activates the
    moment a Prettier config exists, so a partly swept tree would drip formatting noise into
    every unrelated commit afterward.
