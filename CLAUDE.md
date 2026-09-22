# CIDRella

IP Address Management (IPAM) appliance with DNS and DHCP via dnsmasq. Single-box deployment:
Node.js 24 + Express 5 + better-sqlite3 on the backend, Vue 3 + PrimeVue v4 + Pinia + Vite on
the frontend, dnsmasq managed alongside. Ships as a signed release tarball installed natively
(systemd, A/B slots) or via Docker.

## Layout

- `server/`: Express API, SQLite models, dnsmasq config generation, DNS proxy. Entry:
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
```

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
- **Review findings** accumulate in `REVIEW.md`. When an item is fixed, mark it with
  ~~strikethrough~~ and a `[FIXED]` tag rather than deleting it.
- **Work tracking is split by how far along the work is, and the split is deliberate.**
  `TODO.md` is for things that have NOT begun: an idea, no context yet. `BACKLOG.md` is for
  work IN FLIGHT: started, deferred, or blocked, where thought or code has already been spent
  and there is a blocker, a measurement, or a rejected approach worth keeping. An item
  graduates from TODO to BACKLOG when it acquires that context. `BACKLOG.md` is the ONLY
  backlog: it was consolidated from four scattered locations on 2026-08-19, and `REVIEW.md`,
  `PLAN.md` and `docs/SESSION-STATUS.md` now point at it rather than carrying their own lists.
  Do not start a fifth. A `REVIEW.md` finding that will not be fixed in the current pass
  graduates to `BACKLOG.md`; findings marked FIXED stay in `REVIEW.md` as history.
- **Screenshots and throwaway prototypes** go in `screenshots/` (gitignored), never the repo
  root.
- **Git**: the maintainer runs all commits, tags, and pushes. Claude prepares changes and
  commit messages but never commits.
- **Shared things exist, use them.** Before writing a component, style rule or helper, check
  this list and grep for the name. Client: every vendor component is imported through
  `client/src/ui/*.js`, never from the package; `EmptyState`, `StatusDot`, `StatusBadge`,
  `AddressTypePill`, `ConfirmDialog` (every danger or warn confirmation, with
  `type-to-confirm` for the typed gates), `ScanToggle` (`inherits-from` names the parent),
  `DiscardPrompt` + `useDiscardGuard`, `AllowlistDialog`, `networks-workspace/dialogs/RangeTypeDialog`
  + `RangeTypeFields` (the one Network Range Type editor: Settings uses the dialog, RangeEditor
  the fields inline; type writes go through the subnet store so its type cache drops), `WorkspaceHead` (title, lede, Refresh and the range select of a
  reworked Analytics section), `SeriesChart` (every area chart of minute rows, with per-series
  `aggregate` and `summary`; legend chips toggle series), `StackedBar` (a split as one bar with
  a toggling legend; `dashboard/AllocationBar` wraps it), `TopList` (a ranked list with bars,
  every top-10), `dashboard/FigureCard`; `utils/format.js` (`apiError`,
  `formatNumber`, `displayOnlineStatus`, `EMPTY_CELL`), `utils/chart-config.js` (colors,
  `RANGE_OPTIONS`, `rangeLabel`, line and doughnut options), `utils/dateFormat.js`,
  `utils/proxy-perf.js` (the resolution and process figures from the proxy-perf rows),
  `utils/service-chips.js` (the dnsmasq, proxy and forwarder chips), `utils/ipTableDisplay.js`
  (`ipSourceLabel`, the one label for a DNS, DHCP or detection source), and in
  `views/networks-workspace-data.js` the `ipRowFields` adapter that fills every shared IP
  column for the workspace tables (both the Addresses and DHCP adapters spread it; add a
  column there, never in one adapter). Shared styles: `assets/utilities.css` (global, loaded by
  `main.js`: `muted`, `text-sm`, `w-full`, `mono`, `sr-only`, `action-buttons`,
  `dialog-actions`, `card-header`, `field-error`), `assets/analytics-workspace.css` for the
  reworked Analytics sections (head, rail, chip, panel, `.board` with `--board-columns` and
  the `split`/`three` modifiers, `.figures` with `--figures`, `.lists` with `--lists`), `assets/panel-chrome.css` for the
  DNS/DHCP panel info bar and sidebar search, `networks-workspace/dialogs/range-dialogs.css`
  for the range dialogs' form grammar, `assets/analytics-layout.css` for
  the sections not yet reworked, `ui/tokens.css` for `--cid-*`. Server: `utils/validation.js`,
  `utils/ip.js` and `utils/cidr.js`, `services/ip-lifecycle-service.js` for every lifecycle
  write, `models/ip-view.js` for every server-owned display field (status, type, and
  `dhcp_lease_state` from the newest lease; any read that shows an address feeds it
  `in_dynamic_pool` and `dhcp_expires_at` rather than computing its own). Add to this list when you
  make something shared. Four guards enforce what they can detect, each baselined so it fails
  only on NEW instances (fix one by deleting its baseline entry, never by adding one):
  `npm run lint` refuses a vendor import outside `src/ui`, a raw `<select>`/`<input>` outside
  the baselined files, and a `dot`/`pill`/`badge` class outside the status components;
  `npm run check:reuse` runs `check-duplicate-exports.js` (a local copy of an exported helper),
  `check-scoped-css-dupes.js` (an identical rule in two scoped style blocks; `--drift` lists
  same-name-different-body candidates as a report) and `check-confirm-dialogs.js` (a Dialog
  whose footer carries its own danger or warn Button instead of using ConfirmDialog; its
  baseline is empty). CI runs all of them.
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
