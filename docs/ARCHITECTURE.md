# CIDRella Architecture Notes

This document records the intended backend ownership boundaries. The current
codebase is being moved toward this structure incrementally; it is not a claim
that every module already follows it.

## Database Ownership

CIDRella should avoid ad hoc database writes from route handlers and utility
modules. Debugging IP/DNS/DHCP state is much harder when several execution
paths can write the same table with slightly different semantics.

The target shape is:

| Layer | Responsibility |
| --- | --- |
| `server/src/db/` | Connection lifecycle, migrations, DB adapters, low-level initialization. |
| `server/src/models/` | SQL ownership for one table or aggregate. Models own table-specific write semantics. |
| `server/src/services/` | Cross-model workflows, transactions, audit coordination, queued side effects, filesystem/process coordination. |
| `server/src/routes/` | Auth, input parsing, request validation, response shaping. Routes should not own persistence semantics. |
| `server/src/utils/` | Pure helpers or external process/file utilities. Utilities that own DB writes should either move to `services/` or be explicitly allowlisted. |

The priority is centralized writes. Read-heavy projections and validation
queries may remain close to routes until moving them meaningfully reduces
duplication or ambiguity.

## Existing Pattern

`server/src/models/ip-address.js` is the reference pattern for write ownership:
IP lifecycle writes, liveness writes, rogue state, stale cleanup, and IP event
emission should go through the IP model. `server/src/models/ip-view.js` owns the
canonical API/read display projection for IP state.

New ownership boundaries should follow the same spirit: keep table-local write
rules in models and put multi-table behavior in services.

## Refactor Plan

1. Add guardrails.
   Add a DB write ownership check with an allowlist. Start strict for
   `ip_addresses`, then expand table by table as owners are created.
   The current guardrail is `npm run check:db-ownership`; use
   `npm run check:db-ownership:report` to list remaining direct-write
   consolidation opportunities.

2. Centralize scan ownership.
   Move `network_scans` and `scan_results` writes into a scan model/service.
   Manual and scheduled scan starts should use one atomic "create if idle" path.
   Review whether `/api/scans/probe` should be non-mutating or require write
   permission.
   Current write owner: `server/src/models/scan-run.js`.

3. Centralize DNS ownership.
   Add DNS zone and DNS record ownership. First consolidate PTR writes, then
   move DNS record CRUD, SOA serial bumps, duplicate checks, CNAME/PTR handling,
   and IP sync orchestration.
   Current partial owners: `server/src/models/dns-record.js` owns DNS record
   CRUD from the DNS routes, PTR write helpers, and DNS record SOA bumps;
   `server/src/models/dns-zone.js` owns DNS zone CRUD from the DNS routes and
   the zone/subnet domain-name synchronization done during zone rename/delete.
   Pi-hole DNS record import also routes through `server/src/models/dns-record.js`.
   Subnet topology paths still contain DNS writes and are intentionally
   deferred to their topology phase.

4. Centralize DHCP ownership.
   Move reservation writes and lease sync into DHCP services. Lease sync should
   own `dhcp_leases`, DHCP-derived DNS records, and calls into the IP model.
   Current owners: `server/src/models/dhcp-scope.js` owns DHCP scope
   CRUD from the DHCP routes, including explicit scope options and the backing
   range update/delete performed by scope edits.
   `server/src/models/dhcp-reservation.js` owns DHCP reservation CRUD from the
   DHCP routes plus the corresponding IP/PTR synchronization.
   `server/src/models/dhcp-lease.js` owns DHCP lease replacement from the
   dnsmasq lease file plus DHCP-derived DNS A record synchronization.
   `server/src/services/subnet-dhcp-topology.js` owns DHCP table mutations
   required by subnet configure/divide/merge/delete workflows. DHCP table
   ownership is enforced by `npm run check:db-ownership`.

5. Centralize DHCP scopes and options.
   Move custom option and default option writes behind DHCP model/service
   functions. Scope and scope-option route writes are already handled by
   `server/src/models/dhcp-scope.js`; custom/default option writes and startup
   DHCP option maintenance are handled by `server/src/models/dhcp-option.js`.

6. Extract subnet topology.
   Move divide, merge, delete, and configure workflows into a
   `SubnetTopologyService`, using DNS/DHCP/IP/scan models instead of direct
   route SQL.
   Current partial services: `server/src/services/subnet-dhcp-topology.js`
   owns DHCP mutations performed by subnet topology workflows, and
   `server/src/services/subnet-topology.js` owns low-level subnet/range helper
   mutations such as system range creation, subnet insertion, user-range copy,
   parent config clearing, subnet edit/configure transaction bodies, subnet
   merge/delete transaction bodies, buddy/consolidation helpers, and subnet
   name-template application.
   `server/src/services/subnet-dns-topology.js`
   owns DNS mutations performed by subnet topology workflows, including
   forward zone creation, reverse zone/PTR stub creation, and lossy A-record
   cleanup during divide.

   `server/src/models/range.js` owns standalone range CRUD and maintenance
   repairs. Topology services may still mutate ranges when the range is part
   of a subnet/DHCP topology operation. `ranges` ownership is enforced by
   `npm run check:db-ownership`.

   `subnets` ownership is also enforced by `npm run check:db-ownership`.
   Subnet lifecycle and metadata writes live in
   `server/src/services/subnet-topology.js`; the explicit exception is
   `server/src/models/dns-zone.js`, which synchronizes subnet `domain_name`
   pointers when forward zones are renamed or deleted.

   `server/src/models/range-type.js` owns range type CRUD and system range
   type reseeding. `range_types` ownership is enforced by
   `npm run check:db-ownership`.

   `server/src/models/folder.js` and `server/src/models/vlan.js` own folder
   and VLAN CRUD. Subnet-side assignment cleanup still routes through
   `server/src/services/subnet-topology.js`. `folders` and `vlans` ownership
   is enforced by `npm run check:db-ownership`.

   Additional enforced owners:
   `server/src/models/user.js` owns user mutations,
   `server/src/models/setting.js` owns API setting mutations,
   `server/src/models/geoip-rule.js` owns GeoIP rule mutations,
   `server/src/models/anomaly.js` owns route-driven anomaly mutations,
   `server/src/models/blocklist-store.js` owns route-driven blocklist
   mutations, and `server/src/models/audit-log.js` owns audit retention.
   Utility storage owners remain explicit for blocklist refresh/cache,
   MAC vendor cache, metrics aggregation, anomaly-service storage, DB
   initialization, backup/restore, and password reset maintenance.

7. Clean routes.
   Routes should become auth/input/response code. Direct DB writes should
   disappear except for explicit operational exceptions.

## Explicit Exceptions

Some low-level write access is expected and should be allowlisted rather than
hidden:

- migrations in `server/src/db/migrations/`
- DB initialization in `server/src/db/init.js`
- backup and restore implementation
- DuckDB analytics adapter
- maintenance scripts such as password reset
- anomaly service storage, treated as its own storage boundary

## Deferred Cleanup Opportunities

These are similar architecture improvements, but they are deliberately deferred
until core IP/DNS/DHCP/scan ownership is stable:

- Centralize read-heavy dashboard/projection queries into read models.
- Move users, auth, and preference writes into user/settings services.
- Centralize audit log retention and audit write helpers more strictly.
- Clean up blocklist, GeoIP, anomaly, VLAN, folder, range-type, and backup route
  writes.
- Reduce broad `getDb()` exposure in routes after service replacements exist.
- Add import-boundary linting so routes cannot import write-capable DB APIs.
- Promote `check:db-ownership` report-only findings into strict table ownership
  rules as DNS, DHCP, scan, and topology services are extracted.
- Review backup/restore/reset scripts and document why they are exceptions.
- Add ownership documentation mapping each table to its model/service owner.
- Consider read-only DB facades for routes once write centralization is stable.
