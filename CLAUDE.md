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
npm run lint           # ESLint (flat config, correctness-focused), must exit 0
npm run build:client   # production client build, a build failure is a test failure
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
- **Screenshots and throwaway prototypes** go in `screenshots/` (gitignored), never the repo
  root.
- **Git**: the maintainer runs all commits, tags, and pushes. Claude prepares changes and
  commit messages but never commits.
- **UI instrumentation**: key UI elements carry `data-track` attributes consumed by the dev
  tracking endpoint. Preserve them when refactoring components.
- **Linting**: ESLint only (`eslint.config.mjs`), correctness-focused. This codebase
  deliberately has NO Prettier config: it predates the linter, and a mass-reformat would
  destroy git blame. Don't add one; stylistic Vue rules are intentionally off.
