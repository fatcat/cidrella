# Session Status

Updated: 2026-05-29

## Current State

CIDRella 0.4.15 is ready for an extended field-test period. The project tree
was clean before this status file was updated, and the final release gates
passed from the current code.

Completed for 0.4.15:

- Node runtime moved to bundled Node 24.
- Frontend stack moved to Vite 8, Vue Router 5, and Pinia 3.
- Server stack moved to Express 5 and `better-sqlite3` 12.
- Analytics moved from legacy `duckdb` to `@duckdb/node-api` /
  `@duckdb/node-bindings`.
- `raw-socket` / `net-ping` were removed; active liveness uses `arping`
  followed by system `ping`.
- Large blocklist startup memory was reduced by streaming SQLite rows and
  using a single domain-to-category map.
- Crash recovery was added:
  - `server/src/launcher.js` supervises early backend startup.
  - `/var/lib/cidrella/runtime/backend-startup-status.json` records early
    startup state and failure output.
  - Safe mode starts after repeated early backend failures and serves a
    diagnostic page/API on 443 and 8443 when available.
  - Recent systemd/journal crash context is surfaced through
    `/api/health/system` and the header Ops chip after recovery.
- The updater was hardened:
  - `update.sh` marks `update-status.json` failed on nonzero exits.
  - `update.sh` can bootstrap into the verified target release's updater
    after signature, `RELEASE.json`, downgrade, and `min_from` checks.
  - `scripts/build-release.sh` adds harmless legacy placeholder files for
    pre-bootstrap pre.4 updaters that still check old `duckdb` /
    `raw-socket` binding paths.
- Docker docs and compose defaults were improved for DHCP/L2/networking
  deployment concerns.

## Validation

Last full gate run:

- `npm run test:server` passed: 29 files, 359 tests.
- `npm run test:client` passed: 2 files, 25 tests.
- `npm run check:db-ownership` passed.
- `./scripts/build-release.sh --dry-run` passed.

Testerella validation:

- In-UI upgrade to the corrected 0.4.15 pre-release worked.
- Safe mode was tested by intentionally sabotaging `server/src/index.js`.
- Safe mode entered after 3 early failures, captured the thrown error and
  stack, served diagnostics on 443 and 8443, and recovered cleanly after
  restoring the file and restarting `cidrella`.

Production validation:

- The original 0.4.15 release was withdrawn after production's pre.4 updater
  failed with stale native binding checks for `duckdb raw-socket`.
- Current code contains the release-artifact compatibility bridge intended to
  let that pre.4 updater pass the existence-only checks and reach the fixed
  updater path.
- Production should be retried only with a rebuilt 0.4.15 artifact from the
  current tree.

## Next Resume

Recommended next steps after the field-test period:

- Review production behavior after the rebuilt 0.4.15 upgrade.
- Remove the legacy `duckdb` / `raw-socket` placeholder bridge in a future
  release once there are no supported pre-bootstrap updaters to bridge from.
- Consider splitting updater bootstrap into an explicit tiny
  `cidrella-bootstrap-update` entrypoint so the stable bootstrap contract is
  easier to reason about and test.
- Add a real upgrade-path harness scenario when practical; current harness
  coverage is stronger for fresh installs than for old-version-to-new-version
  updates.
