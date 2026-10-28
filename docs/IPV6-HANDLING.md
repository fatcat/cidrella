# IPv6 handling

Status: design, accepted 2026-10-27. Target release: 0.6.3. Rule 5 (hosts) is in scope.

An IPv4 network is an address space: a /24 has 256 addresses, every one can be listed,
counted and drawn, and "how full is it" is a percentage of them. An IPv6 network is not.
A /64 holds 2^64 addresses; a busy one will never use more than a few thousand. Listing what
is free, counting what is left, or measuring fullness in addresses means nothing there.

**The rule this document builds on: an IPv6 network is an inventory, never an address space.**
CIDRella shows what is known about it (allocated, leased, SLAAC, seen) and answers questions
about the rest on request ("is this address free", "give me a free one", "what space is left
in this /48"), without enumerating it.

This is a UI and read-model design. It does not change allocation precedence:
`allocation_state` stays the only allocation authority (AGENTS.md, Canonical IP model gate).
Rule 5 adds a projection that needs a contract change first; see "Contract changes" below.

## Where things stand (surveyed 2026-10-27)

The server already treats IPv6 as sparse. Nothing walks an IPv6 network address by address:

- Per-address rows are made for IPv4 /20 and longer only (`services/subnet-topology.js:446`).
- `GET /subnets/:id/ips` has an IPv6 branch that lists persisted rows plus the network
  address, the gateway and an exact searched address (`routes/subnets.js:2362`).
- Scans discover by all-nodes multicast and the neighbor table, never a sweep
  (`utils/scanner.js:155`); `MAX_SCAN_SIZE` does not apply to IPv6.
- PTRs exist for allocated IPv6 addresses only, in one `ip6.arpa` zone per network
  (`models/dns-record.js:628`, `utils/reverse-zones.js`).
- Pool and range math is BigInt (`backends/shared/pool-segments.js`, `routes/ranges.js`).
- DHCP pool listings show assigned rows only for IPv6 (`routes/dhcp.js:1268`,
  `models/workspace-view.js:499`).
- Bulk runs are capped at 1024 addresses in both families (`subnets.js:2825`,
  `useWorkspaceSelection.js`). The grid is off for IPv6 (`NetworksWorkspace.vue:546`).

What still assumes an address space:

- **Show available** appears on IPv6 networks (`WorkspaceToolbar.vue:20`). There it only adds
  or removes the few synthetic rows above. It cannot list free addresses and looks broken.
- **Utilization.** An IPv6 network has no total (`parseNetwork` returns `size: null` past
  `Number.MAX_SAFE_INTEGER`), so the tile falls back to an assigned count
  (`NetworksWorkspace.vue:1366`). Nothing says how full a /48 is in terms that matter.
- **Choosing an address.** There is no "suggest a free address" in either family; every
  editor takes a typed address (`IpReservationEditor.vue`, `DhcpPanel.vue`). IPv4 users find
  gaps by looking; IPv6 users cannot.
- **Dividing.** Divide is capped at 256 children (`subnets.js:1029`, `splitNetwork`), so a
  /48 cannot become /64s (65,536 children), the most common IPv6 plan. The calculator allows
  65,536 (`subnets.js:2076`) and stores them all in the browser.
- **Full reads.** The IPv6 address list, the network summary (`models/subnet-ip-read.js:106`)
  and the workspace network search (`workspace-view.js:141`) load every stored row before
  paging or counting. RFC 8981 temporary addresses rotate about daily, so a busy /64 grows
  rows faster than an IPv4 network ever could.
- **Search.** Matches a substring of the compressed form, so `2001:0db8` (expanded) misses,
  and there is no prefix search (`subnets.js:2296`, `NetworksWorkspace.vue:719`).
- **One address, one row, nothing joining them.** An IPv6 host has a link-local address, a
  stable global one, often temporary ones, and a DHCPv6 address on a stateful network. Each is
  its own row; the table shows a device five times, and the temporary ones churn.

## Rules

### 1. Inventory, not address space

- The Addresses view of an IPv6 network lists known addresses only. **Show available is
  hidden for IPv6** (toolbar and the DHCP view). The server ignores `showAvailable` on an
  IPv6 network rather than pretending to honor it.
- An exact address typed in the search still returns its row, or an `available` row when
  nothing is stored, so "is this free" stays one search away. That already works; keep it.
- The count line says "N known addresses", never "of M".

### 2. Suggest an address

A **Suggest** control in the address editors (IP Reservation, DHCP Reservation, a DNS
record's address) and a "Next free address" action on a network. It asks the server, which
answers with one free address and never a list:

`GET /subnets/:id/suggest-address?strategy=sequential|random&within=<range id or CIDR>`

- **sequential**: the lowest free address at or above a per-network base offset
  (default `::10` for IPv6, the first usable address after the gateway for IPv4). For servers
  and anything given a memorable address.
- **random**: a random interface ID within the network or the chosen range, retried until
  free. For addresses that should not be guessable.
- Always skipped: allocated and leased addresses, the network address, the gateway, every
  DHCPv6 (or DHCPv4) pool, and, for IPv6, EUI-64 interface IDs (`xxxx:xxff:fexx:xxxx`) so a
  suggestion never collides with a SLAAC host.
- "Free" is decided by the lifecycle read model (`models/ip-view.js` and the claim rules in
  `models/ip-address.js`), not by a new check. The suggestion is advisory: the write still
  goes through `services/ip-lifecycle-service.js`, which refuses a conflict as it does today.
- IPv4 gets the same control; sequential is its natural default.
- Sequential search runs over the sorted claimed set (`address_sort_key`), not the address
  space: the first gap after the base offset is found by walking claims, so cost is bounded by
  the number of rows, not the network size.

### 3. Fullness measured in prefixes

- **A parent network** (one with children) reports how much of its space its children cover:
  "2 /56s and 12 /64s allocated, 0.8% of the /48 covered", computed in BigInt as the sum of
  child sizes over the parent size. That is meaningful in both families and replaces the
  address percentage for IPv6.
- **A leaf IPv6 network** reports counts by kind (static, DHCP reservation, DHCPv6 lease,
  SLAAC, seen only) and, for a stateful DHCPv6 network, its pools' use (leases over pool size,
  meaningful because CIDRella's default pool is 4096 addresses). No address percentage.
- The networks list's 85% warning uses prefix coverage for parents and pool use for leaves,
  so an IPv6 network can warn.

### 4. Prefix planning without listing every child

- **Allocate the next free prefix**: on a parent, "Allocate next free /N" creates exactly one
  child, the lowest free aligned /N, through the existing network create path (topology,
  reverse zone, DHCPv6 defaults all as for a hand-made child). `N` is chosen per request.
  Defaults: /64 under a /56 or longer, /56 under a /48.
- **Free space as blocks**: a parent shows its unallocated space as the smallest set of
  aligned CIDR blocks (`subtractNetwork` in `utils/cidr.js` already computes a complement).
  The list length is bounded by the number of children times the prefix length, never by the
  parent's size. Each block offers "Allocate" and "Allocate next /N inside".
- Divide keeps its 256-child cap: dividing into everything at once stays a small-network
  operation. The calculator keeps its 65,536 cap but stops storing the full list in the
  browser for IPv6; it shows the count, the first and last child, and a page of results.
- Merge is unchanged (BigInt, family-checked).

### 5. Hosts, not just addresses

An IPv6 host is several addresses. CIDRella groups them into a **host** so the table shows
devices, with each device's addresses under it.

**What joins addresses into a host.** Evidence already on the rows, strongest first:

1. A DHCPv6 lease or reservation DUID (`dhcp_duid`), and the MAC inside a DUID-LL or DUID-LLT
   (`macFromDuid` in `utils/duid.js`).
2. The MAC the neighbor table reports for the address (`last_seen_mac`, `mac_address`).
3. The MAC encoded in an EUI-64 interface ID (new helper beside `macFromDuid`).
4. The same MAC on a DHCPv4 lease or reservation, which joins a host's IPv6 addresses to its
   IPv4 one (dual stack).

The host key is the MAC when any source gives one, else the DUID. An address with neither
(no neighbor entry, no lease) is its own host of one. Link-local addresses join by their MAC
and are keyed with their interface, as today (`findNeighbor`, `interface_id`).

**What a host is not.** It is a projection computed from address rows, not an allocation:
it never changes `allocation_state`, ownership, hostname selection or PTRs, and an address's
own row stays its identity (governance plan rule 17: temporary addresses "are distinct address
identities that may share device metadata through a separate, evidence-based host
association"). No new table in the first cut: the host key is derived in the read model, so
there is nothing to keep in step. A table is added only if a host needs its own state (a
name or note the operator sets on the device), which is a later decision.

**How it shows.**

- The Addresses view of an IPv6 network gets a **Hosts / Addresses** switch. Hosts is the
  default for IPv6: one row per host with its name (from the strongest allocation among its
  addresses, by the existing hostname rules), MAC or DUID, vendor and fingerprint
  (`device_fingerprints`, keyed by MAC already), its stable addresses, a count of the others,
  and last seen. Expanding the row lists every address with its kind.
- The details panel of an address names its host and lists the host's other addresses,
  IPv4 included.
- IPv4 keeps one row per address; a host there is usually one address, so the switch is
  offered but Addresses stays the IPv4 default.

**Stable versus temporary.** CIDRella cannot tell a temporary address (RFC 8981) from a stable
random one (RFC 7217) from the address alone, and nothing marks one today: the lifecycle
service accepts a `temporary` flag (`detection_source = 'slaac_privacy'`) that no caller sets.
The first cut classifies by evidence it has:

- EUI-64, DHCPv6, a reservation or a static allocation: stable.
- A SLAAC address of a host that has a longer-lived SLAAC address in the same prefix, seen for
  less than a day: likely temporary, collapsed under "N other addresses".
- Anything else: shown, not collapsed.
  The existing one-hour offline retirement still removes departed temporary addresses.

**Scale.** Grouping runs in SQL over the network's rows (group by the derived key), paged by
host, so a /64 with thousands of temporary addresses reads as tens of hosts.

**Follow-on, not in 0.6.3.** The host key is the device identity anomaly detection lacks for
IPv6 (ARCHITECTURE.md, Known limitation). Keying anomaly identity on it is a separate change
in the server and the sidecar; this design makes it possible but does not do it.

### 6. Search that understands IPv6

- A query that parses as an address matches that address in any spelling (as today).
- A query that parses as a CIDR (`2001:db8:5::/48`) matches every address inside it, as a
  range on `address_sort_key` (fixed-width hex), and in network search every network inside
  or containing it.
- Any other query that looks like hex and colons is matched against the expanded form as well
  as the compressed one, so `2001:0db8` and `db8:5` both find `2001:db8:5::1`.
- The client explorer search gets the same containment rule for CIDR queries.

### 7. Page in the database

The IPv6 address list, the summary counts and the workspace network search page and count in
SQL instead of loading every row:

- Address pages: `ORDER BY address_sort_key LIMIT ? OFFSET ?` per network, with a new index on
  `(subnet_id, address_sort_key)` (the existing `idx_ip_addresses_canonical_sort` leads with
  the family, so it cannot serve a per-network page).
- Summary: `COUNT(*)` grouped by state in SQL, not in JavaScript over loaded rows.
- Network search by address: containment by sort-key range against each network's bounds,
  not a scan of every IP row.
- The synthetic rows (network address, gateway, searched address) are merged into the page
  they sort into.
- Decided 2026-10-28: only the plain view (no search, no filters, address order) pages in
  SQL. Text search, column filters, facets and the other sorts read fields that only
  `models/ip-view.js` computes; putting them in SQL would restate its rules there, the second
  precedence tree AGENTS.md forbids. Those keep the in-memory path over the network's rows,
  and a CIDR search narrows the rows loaded to its sort-key range first.

### 8. What stays as it is

Neighbor Discovery scanning, PTRs for allocated addresses only, BigInt pool math, the
1024-address bulk cap, the 256-child divide cap. Not implemented, by decision on 2026-10-27:
a grid for IPv6 networks (impractical at IPv6 sizes) and IPv6 in the classic views (they go
with the classic-view removal).

## Contract changes (before any code)

The canonical IP model gate (AGENTS.md) applies to rules 2, 5 and 7:

- `docs/ARCHITECTURE.md`, Canonical IP Model: add the host association (rule 5) as a
  projection with its evidence order, and state that it never affects allocation, hostname
  selection or PTRs. Add the suggestion rule (rule 2): advisory, decided by the read model,
  enforced by the lifecycle service.
- `docs/API_MODEL.md`, IP Read Model: the host read (`GET /subnets/:id/hosts`), the host key
  on address reads, `suggest-address`, and that `showAvailable` is ignored for IPv6.
- `docs/IP-LIFECYCLE-GOVERNANCE-PLAN.md`: rule 17 points at this design for the association.

## Phases (all 0.6.3)

1. **Read side**: rules 1, 6 and 7. Hide Show available for IPv6, IPv6-aware search, SQL
   paging and counts with the new index (a migration). Small, no contract change beyond the
   read model. Done 2026-10-28: migration 092, contract text in `docs/API_MODEL.md`
   (Network Read Model).
2. **Planning**: rules 2, 3 and 4. Suggest an address (both families), prefix coverage and
   pool use, next free prefix, free blocks, the calculator change. Contract text for rule 2
   lands first.
3. **Hosts**: rule 5. Contract text first, then the EUI-64 helper, the host key in the read
   model, `GET /subnets/:id/hosts`, the Hosts view and the details panel.

Each phase: an IPv4 and an IPv6 test for every behavior (AGENTS.md, IPv4 and IPv6), the
Networks workspace model test extended for the new controls
(`client/tests/unit/views/networks-workspace/model/`), and `npm run check:db-ownership`.

Tests that matter most:

- Suggest never returns a claimed address, a pool address, the gateway or an EUI-64 ID, in
  both families, and the lifecycle service still refuses a conflicting write made with it.
- Next free prefix is aligned, inside the parent, and never overlaps a child, at /48, /56 and
  /64 parents; free blocks plus children exactly cover the parent.
- Host grouping: a DUID-only DHCPv6 host, a MAC-only SLAAC host, an EUI-64 address, a
  dual-stack host joining its IPv4 address, a link-local address on two interfaces, an address
  with no evidence (its own host); and that grouping never changes `allocation_state`.
- SQL paging returns the same rows in the same order as today's in-memory paging, with the
  synthetic rows in place, on a network with 10,000 rows.

## Open decisions

- **Suggestion strategies.** Proposed: sequential and random as above. Alternatives to rule on:
  a "sparse" strategy (spread addresses across the network) or per-range strategies.
- **Next free prefix sizes.** Proposed: any prefix length, chosen per request, with the
  defaults above. The alternative is a fixed menu (/56, /60, /64).
- **Temporary-address classification.** The evidence rule in rule 5 is a heuristic. If it
  misjudges in practice, the fallback is to collapse nothing and only sort stable addresses
  first.
- **Host state.** Whether an operator can name or annotate a host (needs a table and its own
  lifecycle), or only its addresses as today.
