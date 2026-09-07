# Session Status

Updated: 2026-09-07

Snapshot of where the tree stands. [RELEASE-NOTES.md](../RELEASE-NOTES.md) is canonical
for what actually shipped. [BACKLOG.md](../BACKLOG.md) is the one place for work in
flight.

## Current State

`main` is at `fb5f333`, version **0.4.18, built but not released**. v0.4.17 shipped
2026-09-02.

**0.4.18 is a breaking release.** `min_from` is 0.4.17, the legacy
`ip_addresses.status` field is removed, and schema runs to **61**. Upgrades from
schema 54 inventory ambiguous DNS and DHCP claims before mutating anything and can
refuse to proceed until an operator reconciles them.

Landed since 0.4.17:

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

Last full gate run, at `fb5f333`:

- `npm run lint` passed, zero findings.
- `npm run test:server` passed: 88 files, 1038 tests.
- `npm run test:client` passed: 26 files, 170 tests.
- `npm run build:client` passed.
- `scripts/check-release-version.js` passed (package.json 0.4.18 matches the
  RELEASE-NOTES heading).
- `scripts/build-releases-manifest.js --lint` passed, 22 releases parsed.

Not yet validated:

- **0.4.18 has no release artifact.** The published `v0.4.18-pre.*` prereleases predate
  both anomaly merges and the tail of the lifecycle work, so they do not represent this
  tree.
- **No upgrade run against 0.4.18.** Given the breaking migration path and the
  reconciliation gate, an end-to-end 0.4.17 to 0.4.18 upgrade plus a rollback needs a
  built artifact on testerella before release.
- The disposable-appliance live DHCP matrix and the full pre-release security pipeline
  remain release gates, deferred until DHCP can be enabled on a test interface.

Known bad metadata, not fixable in place:

- The `v0.4.18-pre.1`, `v0.4.18-pre.2`, and `v0.4.18-pre.3` tags point at `1d3329f`,
  which is 0.4.17 code, for the `--target` reason above. `v0.4.17-pre.4` is an orphan
  tag with no release attached. The fix is forward-only. To learn what a given artifact
  really contains, read `RELEASE.json` inside the signed tarball, which carries the
  real commit.

## Next Resume

Work in flight lives in [BACKLOG.md](../BACKLOG.md), consolidated there on 2026-08-19.
Do not restart a second list here.

The one open thread specific to this snapshot: cut a 0.4.18 pre-release from `main` and
run the upgrade and rollback validation against it on testerella. Everything the four
items previously listed here tracked has been resolved and is recorded in BACKLOG.md
and the release notes.
