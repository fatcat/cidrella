# Session Status

Updated: 2026-09-09

Snapshot of where the tree stands. [RELEASE-NOTES.md](../RELEASE-NOTES.md) is canonical
for what actually shipped. [BACKLOG.md](../BACKLOG.md) is the one place for work in
flight.

## Current State

Version is **0.4.18, not yet released**. v0.4.17 shipped 2026-09-02.
`v0.4.18-pre.4` and `v0.4.18-pre.5` are published for validation.

`main` is at `58f79ae` plus documentation-only commits on top, so the gate run
below covers all current code.

**0.4.18 is a breaking release.** `min_from` is 0.4.17, the legacy
`ip_addresses.status` field is removed, and schema runs to **69** in the current
working tree. Upgrades from
schema 54 inventory ambiguous DNS and DHCP claims before mutating anything and can
refuse to proceed until an operator reconciles them.

Landed since 0.4.17:

- **Canonical Network/DHCP governance (working tree, not committed).** Gateway
  intent, scope pools, topology revisions, exact transformation plans,
  transactional split/carve/merge, durable configuration generation, repair
  diagnostics, and authoritative client previews are implemented with schema
  64 through 69 and cross-model regression coverage.

- **IP lifecycle governance.** One canonical allocation state and transition boundary
  across Networks, DNS, DHCP, imports, scans, and passive liveness. Schema 55 through
  59. Merged from `plan/ip-lifecycle-governance` in `bd15d7f`.
- **Anomalies page redesign.** Pattern-based triage: flagged clients are classified by
  the shape of their score history (escalating, recurring, resolved one-off, learning
  baseline) and the detector's per-window history is exposed as a timeline. Backed by
  a new `GET /api/anomalies/events`, since `/active` returns only currently-unresolved
  rows and hid recurring and resolved anomalies between occurrences. PR #26.
- **Anomaly identity keyed by MAC** wherever a current DHCP lease makes one known,
  falling back to the IP for static hosts. Schema 60. A device taking over an IP no
  longer inherits the previous holder's learned baseline. PR #27.
- **Device fingerprint change history.** Reclassification of device type, OS family,
  or vendor class on a MAC is recorded rather than overwritten in place. Schema 61.
  PR #27.
- **Migration 060 handles the legacy `anomaly_models` shape.** It assumed the table
  came from migration 042 with `model_path`, but older installations can have an
  equivalent table created by the anomaly sidecar carrying `model_version` instead.
  `server/src/db/init.js` adapts that shape inside the same transaction, keeping the
  published migration immutable, and schema 062 restores the retained model versions.
- **Pre-release tags now pin to the built commit.** `build-release.sh` passed no
  `--target` to `gh release create`, so pre-release tags were created at the default
  branch head instead of at what was built.

Two merge details worth knowing, both from folding PR #27 onto the lifecycle work:

- PR #27's migrations were renumbered from 055/056 to **060/061**. The lifecycle merge
  had already taken 055 through 059, and `server/src/db/init.js` keys applied
  migrations by the integer filename prefix and skips a version already recorded in
  `schema_version`, so a duplicate number silently drops one file of the colliding
  pair.
- In `server/src/models/device-fingerprint.js`, fingerprint drift is measured against
  the row as actually written, not against the incoming DHCP capture. The upsert
  conflict clause keeps manual overrides sticky and keeps the strongest automatic
  classification, so it can decline a weaker incoming value, and a write that never
  happened is not drift.

## Validation

Last full gate run, at `58f79ae`:

- `npm run test:server` passed: 89 files, 1040 tests.
- `npm run test:client` passed: 26 files, 170 tests.
- `npm run build:client` passed.
- `scripts/check-release-version.js` passed (package.json 0.4.18 matches the
  RELEASE-NOTES heading).
- `scripts/build-releases-manifest.js --lint` passed, 22 releases parsed.
- `npm run lint` ignores the gitignored `tmp/` scratch directory and checks tracked
  source consistently in local and CI worktrees.

Not yet validated:

- **No soak on `v0.4.18-pre.5` yet.** It is the first pre-release that carries both
  anomaly merges and the migration 060 fix. `pre.4` predates that fix and should not be
  used.
- **No upgrade run against 0.4.18.** Given the breaking migration path and the
  reconciliation gate, an end-to-end 0.4.17 to 0.4.18 upgrade plus a rollback still
  needs a run on testerella before release.
- The disposable-appliance live DHCP matrix and the full pre-release security pipeline
  remain release gates, deferred until DHCP can be enabled on a test interface.

Known bad metadata, not fixable in place:

- The `v0.4.18-pre.1`, `v0.4.18-pre.2`, and `v0.4.18-pre.3` tags point at `1d3329f`,
  which is 0.4.17 code, for the `--target` reason above. `v0.4.17-pre.4` is an orphan
  tag with no release attached (that is the **0.4.17** line, unrelated to
  `v0.4.18-pre.4` above). The fix is forward-only, and it is confirmed working:
  `v0.4.18-pre.4` and `v0.4.18-pre.5` each point at the exact commit they were built
  from rather than at the default branch head. To learn what a given artifact
  really contains, read `RELEASE.json` inside the signed tarball, which carries the
  real commit.

## Next Resume

Work in flight lives in [BACKLOG.md](../BACKLOG.md), consolidated there on 2026-08-19.
Do not restart a second list here.

The one open thread specific to this snapshot: soak `v0.4.18-pre.5` and run the upgrade
and rollback validation against it on testerella. Everything the four
items previously listed here tracked has been resolved and is recorded in BACKLOG.md
and the release notes.
