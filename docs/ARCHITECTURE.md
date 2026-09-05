# CIDRella Architecture

This document describes the intended backend ownership boundaries and the
current state of the refactor. CIDRella is no longer a route-heavy prototype:
core database writes are being consolidated behind models and services, with
guardrails to prevent new ad hoc writers.

## Runtime Shape

| Area | Implementation |
| --- | --- |
| Web/API | Node.js, Express, ES modules |
| UI | Vue 3, PrimeVue, Pinia, Vue Router |
| Primary storage | SQLite via `better-sqlite3`, WAL mode |
| Analytics storage | DuckDB |
| DNS/DHCP | dnsmasq, generated config/state files |
| DNS filtering | Node DNS proxy for blocklist and GeoIP decisions |
| Anomaly detection | Python sidecar using DuckDB features and SQLite status/scores |
| Native process manager | systemd |
| Docker process manager | s6-overlay |

Persistent state is rooted at `DATA_DIR` (`/var/lib/cidrella` native,
`/data` Docker). Application code is rooted at `/opt/cidrella` on native
installs.

## Layer Responsibilities

| Layer | Responsibility |
| --- | --- |
| `server/src/db/` | Connection lifecycle, migrations, low-level initialization, DB adapters. |
| `server/src/models/` | Table or aggregate ownership. Models own write semantics and local invariants. |
| `server/src/services/` | Cross-model workflows, transactions, audit coordination, queued side effects, process/file coordination. |
| `server/src/routes/` | Auth, permission checks, input parsing, request validation, response shaping. |
| `server/src/utils/` | Pure helpers or external process/file utilities. DB-writing utilities must be explicit exceptions. |
| `server/anomaly/` | Python anomaly sidecar and its storage boundary. |

The highest priority is centralized writes. Read-heavy projections may stay
near routes until a read model meaningfully reduces duplication or ambiguity.

## Canonical IP Model

IP state is the most important shared contract in CIDRella. It is displayed in
Networks, DHCP, and DNS views, so those views must not infer conflicting state.

Current owners:

- `server/src/services/ip-lifecycle-service.js` owns allocation transitions,
  liveness workflows, rogue reconciliation, and stale cleanup across protocol
  and topology sources.
- `server/src/models/ip-address.js` is the low-level lifecycle repository. It
  persists canonical rows and events only for the lifecycle service and its
  internal protocol-metadata projection helper.
- `server/src/models/ip-view.js` owns the canonical IP API/read projection used
  to render assignment status, address type, online state, hostnames, MAC
  details, and range context.

Terminology:

- `allocation_state`: the mutually exclusive authority for an address.
- `ip_display_status`: a derived value of available, DHCP Scope, or in use.
- `address_type`: how an assigned address was instantiated, such as
  static DNS, reserved DHCP, dynamic DHCP, or SLAAC. Rogue is a derived
  classification for an online unassigned address. Available addresses should
  not have a type.
- `online_status`: active/passive liveness state, independent of assignment.
- `hostname`: one primary hostname for an IP. Additional names should be CNAMEs.

The executable vocabulary and allowed state transitions live in
`server/src/models/ip-lifecycle.js`. Normalized protocol ownership and topology
projection are recorded in `docs/adr/001-ip-protocol-table-ownership.md` and
`docs/adr/002-ip-topology-projection.md`.

## Current Write Owners

The ownership checker (`npm run check:db-ownership`) enforces strict ownership
for the tables already migrated. `npm run check:db-ownership:report` lists
remaining consolidation opportunities.

| Domain | Current Owner |
| --- | --- |
| IP lifecycle transitions and liveness workflows | `services/ip-lifecycle-service.js` |
| IP lifecycle persistence and IP events | `models/ip-address.js` |
| IP read projection | `models/ip-view.js` |
| Scan runs and results | `models/scan-run.js` |
| DNS records, PTR helpers, SOA bumps, Pi-hole DNS imports | `models/dns-record.js` |
| DNS zones and zone/subnet domain pointer sync | `models/dns-zone.js` |
| DHCP scopes and explicit scope options | `models/dhcp-scope.js` |
| DHCP reservations and reservation IP/PTR sync | `models/dhcp-reservation.js` |
| DHCP lease replacement and DHCP-derived DNS A sync | `models/dhcp-lease.js` |
| DHCP option defaults/catalog maintenance | `models/dhcp-option.js` |
| Ranges and range repair | `models/range.js` |
| Range types | `models/range-type.js` |
| Folders | `models/folder.js` |
| VLANs | `models/vlan.js` |
| Users | `models/user.js` |
| Settings | `models/setting.js` |
| GeoIP rules | `models/geoip-rule.js` |
| Anomaly route mutations | `models/anomaly.js` |
| Blocklist route mutations | `models/blocklist-store.js` |
| Audit retention | `models/audit-log.js` |

## Topology Services

Subnet topology workflows touch several aggregates and must remain services,
not route-local SQL.

- `services/subnet-topology.js` owns subnet lifecycle helpers, system range
  creation, subnet insertion, user-range copy, parent config clearing,
  edit/configure transaction bodies, merge/delete transaction bodies,
  buddy/consolidation helpers, and subnet name-template application.
- `services/subnet-dhcp-topology.js` owns DHCP mutations needed during subnet
  configure/divide/merge/delete workflows.
- `services/subnet-dns-topology.js` owns DNS mutations needed during subnet
  configure/divide/merge/delete workflows, including forward zone creation,
  reverse zone/PTR stub creation, and A-record cleanup during divide.
- `services/operation-maintenance.js` owns operational maintenance workflows
  that are too broad for a table model.

Topology services may call model functions and may own transaction boundaries.
Routes should pass validated inputs and turn service results into HTTP
responses.

## Liveness and Scanning

Liveness comes from active and passive sources:

- active scans use the scanner and `models/scan-run.js`
- passive DHCP lease activity routes through DHCP lease sync and IP model writes
- passive DNS query activity routes through `utils/ip-liveness.js`

Manual probes and scheduled scans should share the same probe implementation.
ARP should be attempted first where appropriate, with ICMP ping fallback inside
the same scan lifecycle event.

## DNS/DHCP Config Generation

dnsmasq files are generated from database state using atomic writes. Different
file classes have different reload behavior:

- hosts-style files can usually be hot-read by dnsmasq
- CNAME/MX/TXT/SRV and other `conf.d` changes require reload/SIGHUP
- DHCP host and scope changes regenerate the corresponding dnsmasq state

The backend should keep DNS and DHCP table ownership in models/services; config
generators should read and emit, not invent persistence semantics.

## Security and Operations Boundaries

Expected low-level write exceptions:

- migrations in `server/src/db/migrations/`
- the startup-only canonical address backfill in `server/src/db/ip-identity.js`
- DB initialization in `server/src/db/init.js`
- backup and restore implementation
- DuckDB analytics adapter
- anomaly sidecar storage in `server/anomaly/storage.py`
- maintenance CLI scripts such as password reset and web port reset
- metrics/log/cache utilities that are explicitly allowlisted

Native installs should rely on systemd ambient capabilities for privileged
ports and raw probes. The install path should warn if ambient capabilities are
not supported.

Outbound URL fetches must use the guarded/pinned URL helper in
`utils/url-guard.js` when the URL is operator supplied.

## Guardrails

Use these before committing:

```bash
npm run check:db-ownership
npm test
```

For refactor planning:

```bash
npm run check:db-ownership:report
```

The ownership checker is intentionally table-by-table. Do not hide every SQL
statement just to satisfy an abstraction. The goal is clear ownership of writes
and predictable domain behavior.

## Deferred Cleanup

These are valuable but not required before the core ownership model is stable:

- Add route import-boundary linting so migrated routes cannot import write DB
  primitives.
- Move read-heavy dashboard and analytics queries into explicit read models.
- Continue reducing direct `getDb()` exposure from routes as services mature.
- Tighten settings upserts to avoid `INSERT OR REPLACE` where metadata matters.
- Add a machine-readable table-to-owner map consumed by docs and CI.
- Review backup, restore, reset, and install scripts as explicit exceptions and
  keep their command/file safety tests focused.
