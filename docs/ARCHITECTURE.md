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
| DNS/DHCP | dnsmasq behind the backend layer (`server/src/backends/`), generated config/state files |
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
| `server/src/backends/` | DNS/DHCP backend adapters behind one contract (`contract.js`) and a registry (`index.js`). Adapters render, activate and read their daemon; they never write the database. |
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
  static DNS, DHCP Reservation, dynamic DHCP, IP Reservation, or SLAAC. System
  is reserved for topology-defined non-host addresses: the IPv4 network and
  broadcast addresses and the IPv6 subnet-router anycast address. Rogue is a
  derived classification for an online unassigned address. Available addresses
  should not have a type.
- `network_range_type`: an optional custom organizational tag projected from
  a non-system range. It does not affect allocation, DNS, DHCP, scanning, or
  topology. Custom Network Range Type ranges cannot overlap each other.
- `online_status`: active/passive liveness state, independent of assignment.
- `hostname`: one primary hostname for an IP. Additional names should be CNAMEs.
- `IP Reservation`: an administrative address hold with no DHCP client
  identity. Its internal allocation state is `reserved`, owned by
  `admin_reservation`.
- `disabled DNS`: an address held by a manual A or AAAA record that exists but
  is not served (the record or its forward zone is disabled). Its internal
  allocation state is `reserved`, owned by `dns`. It protects the address like
  an IP Reservation; deleting the record releases it. See ADR 004.
- `DHCP Reservation`: a static DHCP client-to-address binding. Its internal
  allocation state is `static_dhcp` and its protocol row is stored in
  `dhcp_reservations`.

Allocation authority and naming are separate. A hostname or PTR value must not
change an address from a protected `system` or `gateway` allocation, and
allocation precedence must not be reimplemented as hostname precedence.
For every usable IPv4 address in a managed subnet with reverse DNS enabled,
reverse-DNS projection provides a PTR row when the subnet has at most 65,536
usable addresses. Larger reverse zones remain supported without full
placeholder materialization. The projection uses the canonical real hostname
supplied by an enabled manual A record, DHCP Reservation, or retained
DHCP-derived DNS record when one exists. Otherwise it uses the canonical IP
text as the placeholder value. An explicitly operator-created, non-placeholder
PTR is an override and is not replaced by reconciliation. Generated PTR rows
carry `dns`, `dhcp`, `reservation`, or `placeholder` provenance so they can
safely converge when their source changes. Every path that creates, changes,
removes, imports, migrates, or reconciles one of those facts must converge on
the same PTR result through the shared DNS/IP lifecycle boundary.

A record name follows the zone-file rule. A name ending in `.` is absolute:
its FQDN is the name without the dot. Every other name is relative to its
zone, dotted or not (`www.sub` in `example.lan` is `www.sub.example.lan`,
and an SRV name `_sip._tcp` is `_sip._tcp.example.lan`). Names are stored
lowercase; `@`, the zone name itself, and a name ending in `.<zone>` (with or
without the dot) are stored relative (`@`, or the part before the zone).
`normalizeRecordNameForZone` is the one write sink for that form and
`fqdnForRecordName` the one reader, and any SQL that builds an FQDN must give
the same answer (`@` is the zone, a trailing dot is absolute, anything else
gets `.<zone>`). Importers whose names are absolute by meaning, the Pi-hole
import, mark an out-of-zone name with the trailing dot. Before 0.5.1 a dotted
name without the dot was served as absolute; migration 082 added the dot to
those so they kept serving the same name.

A DHCP lease's name is its effective name (ADR 005), decided when leases are
read from dnsmasq and before they are stored: unique within its forward zone
and sticky to the address that holds it. A client whose name another address
holds gets the first free suffix `-00` through `-FF`; a client that sends no
name keeps the name its address holds before any vendor fallback applies.

dnsmasq serves the PTR result from its hosts file: every A and AAAA name is
written to `hosts.d/records.hosts` with each address's canonical PTR name
first, since dnsmasq answers a reverse lookup with the first hosts line for an
address and reloads that file without a restart. Only a PTR the hosts file
cannot answer (an operator override, or a PTR with no matching A record) is
written as a `ptr-record` line in `conf.d`, which needs a restart.

Every enabled zone, forward or reverse, answers the names under it itself:
`conf.d/local-zones.conf` holds a `local=/zone/` line for each, so a name or
type CIDRella has no record for gets NXDOMAIN or NODATA from dnsmasq instead
of a lookup upstream. A zone with `forward_unknown` set is left out, for a
split-horizon domain whose public records CIDRella does not hold; its unknown
names go upstream as before.

IPv6 topology follows the same model with three differences. The subnet-router
anycast address is the network address of the prefix and is the only IPv6
`system` row; there is no broadcast address, no Broadcast range, and no
broadcast exclusion anywhere. Gateway policy `first` means network plus one
and `last` means the last address of the prefix, because IPv6 reserves no
endpoints. An IPv6 network never materializes per-address rows: only topology
rows and observed or allocated facts persist, reads are sparse, and
utilization reports counts rather than a total when the prefix exceeds what a
JavaScript number holds. Reverse projection for IPv6 writes PTR rows only for
allocated addresses, into one `ip6.arpa` zone at the nibble boundary of the
prefix (the prefix length rounded down to a multiple of four, at most 31
nibbles, so a /128 uses its /124 zone), and never walks the address space for
placeholders. Releasing an IPv6 address to `unassigned` removes its
bare-address placeholder PTR with it; IPv4 keeps one for every address.
Point-to-point and host prefixes (/31, /32, /127, /128) reserve nothing, so
none of their addresses is a `system` row (RFC 3021, RFC 6164).

Known limitation: anomaly detection identifies a client by its DHCPv4 lease
MAC, falling back to its address (`resolveIdentity` in `models/anomaly.js`,
`resolve_device_key` in `server/anomaly/storage.py`). A DHCPv6 lease carries a
DUID, not a MAC, and a SLAAC host has no lease, so every IPv6 client is scored
under its current address. In practice: a host's IPv6 traffic is a separate
client from its IPv4 traffic, so allowlisting it by its IPv4 address does not
cover its IPv6 queries; and an RFC 8981 temporary address rotates about daily,
before the 48 hours of history training needs, so those addresses stay in
learning and are never scored. Lifting it means keying identity, history and
training on the device (the DHCPv6 DUID, or the Neighbor Discovery MAC) rather
than on one address, in both the server and the sidecar.

Hostname selection is centralized in `models/ip-lifecycle.js`. A `static_dns`
or `gateway` address takes its name from static DNS. A `static_dhcp`
address takes its DHCP Reservation name, and a `dynamic_dhcp` address takes its
DHCP Lease name. An address without a protocol-owned allocation may retain
learned naming metadata during its retirement window; ties resolve as static
DNS, DHCP Reservation, then DHCP Lease. That window is the offline one: a lease
name outlives its lease only while the host is absent. An address that is
online with no owner (a rogue) drops its lease name at once, whether the lease
lapsed while the host was up or the host reappeared still carrying a retained
name; what the device calls itself stays available as DHCP fingerprint
evidence, keyed by MAC. This selection changes naming only and never changes
`allocation_state`.

The executable vocabulary, allowed state transitions, and canonical hostname
selector live in `server/src/models/ip-lifecycle.js`. Normalized protocol
ownership and topology projection are recorded in
`docs/adr/001-ip-protocol-table-ownership.md` and
`docs/adr/002-ip-topology-projection.md`.

The allocation a manual A or AAAA record implies does not depend on whether
the record or its network came first. Configuring a network adopts the
records that already name its addresses, and startup runs the same
reconciliation (`reconcileStaticDnsAllocations`) so rows that drifted
converge. Addresses owned by DHCP, topology or an IP Reservation are left
alone. A record inside an enabled DHCP scope is reported as a conflict,
not allocated.

CIDRella's interface addresses have no special allocation state. When an
enabled manual A or AAAA record names one, it is an ordinary `static_dns`
allocation and receives the same DNS-versus-DHCP exclusion as every other
static DNS address. DNS and DHCP service roles are capabilities, not allocation
types.

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
| DHCP Reservations and DHCP Reservation IP/PTR sync | `models/dhcp-reservation.js` |
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
  intermediate-container consolidation, and subnet name-template application.
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

### Canonical network and DHCP transformations

The network model owns normalized CIDR and persistent gateway intent (`first`,
`last`, `custom`, or `none`). `gateway_address` is the resolved value and
`topology_revision` is the concurrency boundary for transformation plans.

Inherited/global scheduled scanning applies only to non-global IPv4 networks.
Globally routable networks require an explicit per-network scan opt-in. Manual
targeted scans remain explicit operations. This prevents an IPAM-only public
prefix from causing Internet hosts to be classified as local rogue devices.
Global Network Defaults initialize new independent networks only. They do not
rewrite existing policy during split or merge.

Split, carve, and merge compile through one deterministic plan and execute in
one transaction. The transaction rehomes IP identities, DHCP scopes and pool
intervals, reservations, leases, DNS/PTR projections, and organizational range
fragments before removing source ownership. It then reconciles topology roles
through the canonical IP lifecycle service. See
[ADR 003](adr/003-network-dhcp-transformation-ownership.md) and the
[Network/DHCP governance plan](NETWORK-DHCP-GOVERNANCE-PLAN.md).

## Liveness and Scanning

Liveness comes from active and passive sources:

- active scans use the scanner and `models/scan-run.js`
- passive DHCP lease activity routes through DHCP lease sync and IP model writes
- passive DNS query activity routes through `utils/ip-liveness.js`

Manual probes and scheduled scans should share the same probe implementation.
ARP should be attempted first where appropriate, with ICMP ping fallback inside
the same probe. A probe updates `last_scanned_at`; address history records only
a change of liveness (online, offline), never the probe itself.

An unanswered probe marks a host offline only when nothing else heard from it
since the previous scan. Many devices ignore probes and still renew DHCP or
query DNS all day; while any source has seen the host after the last scan
(`last_seen_at` newer than `last_scanned_at`), a missed probe leaves it online
and writes no event. After a whole scan interval of silence the next miss marks
it offline. An unanswered probe never makes the scanner the address's
`detection_source`: only a reply does.

A host that was online when the scan began is not called offline on one missed
probe. When its ARP request (IPv4) and single echo both go unanswered, it gets
`OFFLINE_CONFIRM_PINGS` more echoes, and one reply keeps it online. WiFi
clients drop broadcast ARP, which the radio never retransmits, and miss a lone
echo now and then; unicast echoes are retransmitted. A host already offline gets
no retry, so a scan of empty addresses costs nothing extra.

A stored MAC is authoritative only where DHCP sets it: a DHCP Reservation's
client (`static_dhcp`) and a live lease's holder (`dynamic_dhcp`). A different
MAC answering there is a scan conflict ("MAC mismatch"). Anywhere else (a DNS
record, a gateway or other topology address, an unassigned row) the stored MAC
is only the last one seen, so a scan that sees another replaces it once and
records `mac_changed` with source `scanner`; a NIC swapped or a VM recreated is
not a conflict on every scan after. `macIsAuthoritative` in
`models/ip-lifecycle.js` is the one test of which is which.

## DNS/DHCP Config Generation

Everything that changes what DNS or DHCP serve goes through the backend layer:
an after-commit hook (`regenerate_dns`, `regenerate_dhcp`,
`regenerate_dnsmasq_conf`) runs `services/backend-apply.js`, which calls the
adapter for each role from `backends/index.js`. Apply operations are desired
state: they read the database, make the daemon match it, and report
`{changed, activation, activated}`. Adapters never write the database
(`check-db-ownership` refuses it); neutral work such as `syncDhcpDnsRecords`
and lease ingestion (`services/dhcp-lease-sync.js`) stays in services. Only
`backends/**` imports an adapter, enforced by ESLint and
`scripts/check-backend-imports.js`. `docs/DNSMASQ-COUPLING.md` maps the seams
and what is left for Kea and PowerDNS.

The dnsmasq adapter (`backends/dnsmasq/`) generates its files from database
state using atomic writes. Different file classes have different reload
behavior:

- hosts-style files can usually be hot-read by dnsmasq
- CNAME/MX/TXT/SRV and other `conf.d` changes require reload/SIGHUP
- DHCP host and scope changes regenerate the corresponding dnsmasq state

The backend should keep DNS and DHCP table ownership in models/services; config
generators should read and emit, not invent persistence semantics.

### DHCP option layering

`resolveEffectiveScopeOptions` (`models/dhcp-scope.js`) is the one place a
scope's served options are worked out; dnsmasq and Kea render its
`effective.options` and never read the option tables. A default
(`dhcp_option_defaults`) reaches a scope only through a linked row: a
`dhcp_scope_options` row with `value IS NULL` (`isLinkedOption`), shown as Use
default. A linked row serves the default's current value, so an edit of the
default reaches every scope using it, and an empty default serves nothing.
`enabled_by_default` (Add to new scopes) only picks the defaults a new scope
links. Precedence, lowest first: IPv4 linked default, the scope's own rows, the
legacy scope columns (only when the scope has no rows with its own value), the
network; IPv6 linked default, legacy columns, own rows, the network. IPv4
option 51 is the scope's `lease_time`, never a default. Writers mark a link
with `USE_DEFAULT` (`services/subnet-dhcp-topology.js`), which
`writeScopeOptionRows` stores as NULL; copies between scopes (divide, merge)
carry the value as-is, so links survive.

### Why an answer failed

The DNS proxy sorts every failed answer into one cause with `failureCause` in
`utils/dns-ede.js`, from the rcode and the Extended DNS Error (RFC 8914, EDNS
option 15) in the answer. The query log keeps the EDE code and the cause per
query; the minute rows keep a count per cause.

| Cause | When |
| --- | --- |
| `dnssec` | SERVFAIL with EDE 1, 2, 5 to 12, 25 or 27 |
| `upstream` | SERVFAIL with EDE 22 or 23 |
| `timeout` | the proxy gave up waiting for dnsmasq |
| `refused` | REFUSED |
| `other` | any other SERVFAIL, including one with no EDE |

Measured on dnsmasq 2.91 (2026-10-08, scratch instances on testerella):

- A name that fails validation gets SERVFAIL with an EDE of dnsmasq's own: 6
  (DNSSEC Bogus) or 7 (Signature Expired) for `dnssec-failed.org`.
- dnsmasq relays the EDE an upstream sends with its SERVFAIL, whether or not it
  validates itself. So the encrypted forwarder's own SERVFAIL carries EDE 22
  when no provider answered, and that reaches the client as `upstream`.
- A dead or refusing plain upstream gets no answer from dnsmasq at all; it
  gives up after 10 seconds. The client, or the proxy in front of it, times out,
  which is why `timeout` is its own cause and the forwarder keeps a query
  under 4.5 seconds.
- Local names answer with no EDE.

Each upstream address also gets a minute row in `metrics_forwarder` (queries,
answers, timeouts, resent drops, refused connections, failovers, p50 and p95
latency), plaintext included.

### Upstream forwarding: primary, backup, and the timing chain

With recursion on, dnsmasq has one `server=` line, `127.0.0.1#5356`, in every
mode. The forwarder there (`utils/encrypted-forwarder.js`, named for where it
started) sends each query on as plain DNS, DoT or DoH. Plaintext has its own
path because dnsmasq left to itself does not take turns: on dnsmasq 2.91 two
plain servers got 45 queries to 1.

The forwarder has at most two upstreams, a primary and a backup
(`dns_upstream_servers` and `dns_upstream_backup_servers` for plaintext, read
through `plainUpstreams()` in `utils/forwarding-settings.js`;
`forwarder_encrypted_upstreams` for DoT and DoH). `dns_upstream_backup_mode`
says where a query starts:

- **On failure** (`failover`): always at the primary. The backup is asked only
  when the primary gives no answer.
- **Load balance** (`balance`, the default): the two take turns, and each is
  asked when the other gives no answer.

A resolver's addresses are tried in order within it. An upstream that gave no
answer is held for 30 seconds (`ENCRYPTED_FORWARDER_HOLD_MS`): it goes to the
back of the line until it answers again or the settings change, so a dead
primary costs one slow query, not one per query.

The waits nest so each layer answers before the one in front gives up: a send
waits 2.5 s (`ENCRYPTED_FORWARDER_TIMEOUT_MS`), a query gets 4.5 s across
every upstream (`ENCRYPTED_FORWARDER_BUDGET_MS`), the DNS proxy waits 5 s for
dnsmasq (`PROXY_UDP_TIMEOUT_MS`), and dnsmasq waits 10 s for the forwarder.
When nothing answers the forwarder returns SERVFAIL with EDE 22; there is no
fallback from encrypted to plaintext.

### What deallocating a network takes with it

Deallocating (or deleting) an allocated network removes what the app wrote for
it and keeps what a person wrote. DHCP scopes, scope options and leases go.
PTR records with source `placeholder`, `dhcp` or `reservation` for addresses
inside the block go, found by address in every reverse zone that overlaps the
block (after a divide a child's PTRs live in its parent's zone), as do A/AAAA
records with source `dhcp` or `reservation`.
Manual records and the `dns` PTRs that mirror them stay. Forward zones are
shared DNS objects and are never touched. Each reverse zone the block maps to
is disabled unless another allocated network with reverse DNS still overlaps
it; configuring the block again with reverse DNS re-enables the same zone rows.
DHCP reservations are a promise someone made on purpose, so the delete refuses
with 409 `reservations_present` while any exist in the network or below it.
`GET /api/subnets/:id/deallocation-preview` reports the same selection
read-only for the confirmation dialog (`subnet-dns-topology.js`
`dnsDeallocationImpact`, `subnet-topology.js` `deallocationPreview`).

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

### Sign-in sessions

A login JWT names a row in `sessions` (`sid`), and that row, not the token,
decides whether the login still works. `models/session.js` holds every rule:

- A session ends after `session_idle_timeout_minutes` without activity (0, 15,
  30 or 60; 0 is no inactivity limit), and always 24 hours after sign-in. The
  JWT's `exp` matches the 24 hours.
- Activity is a person using the page. The client reports input with
  `POST /api/auth/activity` at most once a minute
  (`composables/useSessionActivity.js`), and only that and sign-in move
  `last_activity_at`. Ordinary requests never do: the dashboards poll on
  timers.
- Signing out, a password change or reset, a role change, deleting a user and
  a restore end sessions through the model, with the reason stored on the row
  and written to the audit log. `users.updated_at` is no longer a revocation
  signal.
- API tokens (`cidr_pat_`) are not sessions and never go idle.

### Filtering pause and hosts with filtering off

Before either filtering check (the blocklist before forwarding, GeoIP on the
answer), the DNS proxy asks `filteringBypass(clientIp)` in `utils/dns-proxy.js`.
Filtering is skipped for every client while `filtering_paused_until` is in the
future, and for one client whose address is in the exempt set. Bypassed
queries log as `allowed`.

- The pause is a stored deadline (`PUT /api/blocklists/pause`, 5, 15, 30 or 60
  minutes from `utils/filtering-pause.js`, 0 resumes). It needs no timer to
  end, and a restart mid-pause keeps it.
- A host is exempt through `filtering_exemptions`, which
  `models/filtering-exemption.js` alone writes. A host is keyed by its device's
  MAC when the address has one (stored, seen by a scan, or on an active lease)
  and by its address otherwise, so a DHCP client keeps the exemption on a new
  lease. The table stands apart from `ip_addresses`, so it outlives that row.
- The proxy holds the exempt addresses in memory (`exemptAddressSet`) and
  rebuilds the set when an exemption or the blocklist settings change, after
  each lease sync, and every minute. The Addresses, DNS and DHCP reads show
  the same answer as `filtering_enabled`, through `enrichIpViewRows`.

### Resolution Map feed

Each filtering decision the proxy makes (a permitted answer, a GeoIP block, a
blocklist block) is recorded once in `utils/resolution-feed.js`, a ring buffer
of the last 2,000 events held in memory and never stored. The Analytics map
polls it (`GET /api/analytics/resolution-map?since=`) with a sequence cursor.
It is separate from the `getAndReset*` counters on purpose: those belong to the
per-minute aggregator, and a second reader would steal its counts.

- An event's place comes from the GeoIP lookup the policy already does.
  `evaluateResolvedPolicy` names a `destination` (country plus city point) for
  every verdict, so it looks answers up even when filtering is paused or off
  for the client; such answers are still never blocked.
- City points come from `server/assets/geo-cities.bin`, built from DB-IP City
  Lite by `scripts/build-geo-cities.js` at release build time and never
  committed. `utils/geo-cities.js` owns its coarsening (cells of about 100 km,
  one place per IPv4 /22 and IPv6 /40 block), its format and its lookup. The
  point is found on a GeoIP cache miss and kept in `geoCache` beside the
  country, so a hit costs nothing extra; a cell naming a different country than
  the country database is ignored. Without the file, answers land at their
  country's middle (`client/src/utils/country-geo.js`, generated by
  `scripts/gen-country-geo.js`).

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
