# IP Lifecycle Governance Plan

- Status: implementation in progress
- Branch: `plan/ip-lifecycle-governance`
- Baseline: CIDRella 0.4.17 plus IPv6 phase-0 address primitives

## Purpose

CIDRella needs one coherent model for every IP address it manages or
observes. DNS, DHCP, network, scanner, and passive-liveness features should all
read and change that model through the same lifecycle boundary.

This plan addresses the lifecycle audit performed after 0.4.17. It does not
prescribe a large table containing every DNS and DHCP field. Protocol tables
may retain normalized details when there is a clear reason, such as multiple
DNS records for one address or current DHCP lease history. They must not become
competing authorities for the address's allocation state.

## Goals

- Give each address exactly one mutually exclusive allocation state.
- Keep allocation, liveness, scope membership, and protocol metadata separate.
- Enforce forbidden combinations before data is written or dnsmasq is changed.
- Make the IP object the canonical aggregate returned to every functional view.
- Ensure DNS, DHCP, network, scanner, and passive paths produce identical
  lifecycle decisions.
- Retire dynamic and rogue host metadata after one continuous hour offline.
- Preserve learned metadata for administratively assigned addresses until the
  administrator changes or removes the assignment.
- Reconcile existing contradictory data safely during migration.
- Make every transition transactional, observable, and covered by tests.
- Make address identity, canonicalization, containment, and sorting work for
  IPv4 and IPv6 without parallel lifecycle implementations.
- Allow later IPv6 management and tracking features to add family-specific
  observation sources without changing the core ownership model.

## Non-goals

- Delivering user-visible IPv6 management, DHCPv6, SLAAC, Router Advertisement,
  or Neighbor Discovery features. This plan defines the lifecycle contract they
  will use, while their implementation remains in the IPv6 project.
- Flattening all DNS records, scopes, reservations, and lease history into one
  database row.
- Replacing dnsmasq.
- Changing unrelated subnet, DNS, or DHCP features.

## Terminology

The word `status` is currently overloaded. The target model uses four distinct
concepts.

| Concept | Meaning | Values |
| --- | --- | --- |
| Allocation state | The mutually exclusive way the address is governed. | `unassigned`, `reserved`, `static_dns`, `dynamic_dhcp`, `static_dhcp`, `slaac`, `system`, `gateway`, `quarantined` |
| Display status | The address's user-facing availability. | `available`, `DHCP Scope`, `in use` |
| Liveness | Whether CIDRella currently believes a host is present. | `online`, `offline`, plus observation timestamps |
| Address family | The protocol family of the canonical address. | `4`, `6` |
| Dynamic-pool membership | Whether an address lies inside an enabled DHCPv4 or DHCPv6 dynamic pool. | boolean plus scope identity |

`rogue` is an observed classification, not an allocation mechanism. A rogue is
an online, unassigned host address. It can still be presented as the address
type `rogue`, but it must not coexist with a legitimate allocation claim.

`system` and `gateway` are protected allocation states. An IPv4 network or
broadcast address is `system`. IPv6 has a subnet-router anycast address but no
broadcast address. A configured or learned router address is `gateway`.
CIDRella's own service addresses are protected system addresses in both
families.

## Decisions Required Before Implementation

The following semantics need explicit approval because the 0.4.17 model and the
desired model use the same words differently.

1. **Reserved versus static DHCP.** This plan treats `reserved` as an inactive
   administrative hold with no MAC requirement, and `static_dhcp` as an active
   MAC-to-IP reservation served by DHCP. Activating a reserved address replaces
   its allocation state with `static_dns` or `static_dhcp`.
2. **DHCP Scope display precedence.** This plan uses `in use` for every assigned,
   rogue, system, or gateway address. An unassigned address inside an enabled
   DHCP scope displays `DHCP Scope`. An unassigned address outside a scope
   displays `available`.
3. **Multiple static DNS names.** One IP may have one canonical static DNS
   hostname and additional names should be CNAMEs. If multiple A records to the
   same IP must be supported, the canonical-hostname selection rule must be
   specified instead.
4. **Disabled configuration.** This plan treats disabled DNS records, DHCP
   reservations, and DHCP scopes as non-authoritative. They remain stored for
   later re-enablement but do not allocate, protect, or classify an IP.
5. **Lease history.** This plan keeps historical lease events outside the live
   allocation object. An expired lease is not an allocation claim.
6. **SLAAC state.** This plan uses `slaac` for an address observed through
   Neighbor Discovery, Router Advertisement context, or other evidence that it
   is autonomously configured. Stable and temporary/privacy SLAAC addresses use
   the same allocation state with separate address properties and lifetimes.
7. **IPv6 retirement.** This plan applies the one-hour offline retirement rule
   to learned dynamic DHCPv6, SLAAC, privacy, and rogue address metadata after
   their authoritative lifetime has ended. A still-valid DHCPv6 lease or SLAAC
   valid lifetime remains an allocation claim even if liveness is offline.
8. **IPv6 gateway authority.** This plan projects configured gateways and
   trusted Router Advertisement router information as `gateway`. DHCPv6 does
   not determine the default gateway.
9. **Link-local identity.** This plan keys a link-local IPv6 address by address
   plus interface/network context. A zone identifier such as `%eth0` is parsed
   at an input boundary and stored as a separate interface reference, never as
   part of the canonical address text.

## Address-family Contract

The lifecycle model is shared, but family capabilities are explicit. Code must
not infer IPv4 behavior from the absence of an IPv6 branch.

| Capability | IPv4 | IPv6 |
| --- | --- | --- |
| Canonical text | Dotted decimal | RFC 5952 lowercase compressed form |
| DNS allocation | A record | AAAA record |
| Dynamic DHCP | DHCPv4 lease inside scope | DHCPv6 IA address inside pool |
| Autonomous allocation | Not applicable | SLAAC with preferred/valid lifetimes |
| Neighbor observation | ARP | Neighbor Discovery |
| Active reachability | ARP then ICMP | Neighbor Discovery then ICMPv6 |
| Broadcast | Protected broadcast address | None |
| Gateway source | Subnet configuration or DHCPv4 scope option | Configuration or trusted Router Advertisement |
| Link-local context | Not applicable | Interface/network identity required |
| Reverse DNS | `in-addr.arpa` PTR | Nibble-reversed `ip6.arpa` PTR |

All addresses must pass through `server/src/utils/address.js` for family
classification and canonical formatting. IPv4-mapped IPv6 input folds to the
canonical IPv4 identity so one endpoint cannot acquire two lifecycle rows.
Fixed-width sort keys from the shared address core should back mixed-family
ordering and indexes. Security-sensitive parsers may remain stricter when their
threat model requires it, but they must return canonical identities before
calling the lifecycle service.

The database must never rely on textual IPv6 spelling for equality. The target
identity is the canonical tuple:

```text
(network/subnet identity, address family, canonical address, interface context)
```

`interface context` is null except where an address is scoped to a link. The
schema design may use canonical text plus indexed sort key or fixed-width
binary storage. The representation must support equality, containment, range
queries, and stable mixed-family sorting without JavaScript-only full-table
scans.

## Canonical IP Aggregate

Every address read model should be produced by one server-side aggregate. At a
minimum it contains:

```text
identity
  ip_address
  address_family
  address_sort_key
  subnet_id
  interface_id when scope requires it

allocation
  state
  source_id
  hostname
  mac_address
  description/note
  preferred_until
  valid_until

liveness
  is_online
  first_seen_at
  last_seen_at
  last_scanned_at
  last_observation_source

classification
  address_type
  rogue_reason
  vendor
  device fingerprint summary

dhcp
  in_scope
  scope_id
  dhcp_version
  lease_status
  lease_expires_at

dns
  canonical record summary
  record type (A or AAAA for forward allocation)
  TTL
  forward and reverse record references

display
  status
  status severity
```

Protocol-specific collections can be nested or fetched as related resources,
but the same aggregate builder must serve the Network, DNS, DHCP, host-details,
and API views. Clients should render these fields and must not independently
reconstruct lifecycle state.

## Allocation Invariants

These rules apply at every write boundary and must also have database or
reconciliation backstops where practical.

1. One canonical address identity has exactly one allocation state. Alternate
   textual spellings and IPv4-mapped IPv6 forms cannot create another row.
2. A dynamic DHCP allocation requires an active lease inside an enabled scope
   or pool of the same address family.
3. Static DHCP may use any valid host address in its leaf subnet, inside or
   outside a dynamic scope, when the selected DHCP protocol supports it.
4. Static DHCP cannot use network, IPv4 broadcast, IPv6 subnet-router anycast,
   gateway, or other system IPs.
5. Static DNS A or AAAA allocation cannot use an address inside an enabled
   same-family DHCP dynamic pool.
6. A reserved address cannot be dynamically leased, even when it lies inside a
   scope.
7. System and gateway addresses cannot be reserved or allocated through DNS or
   DHCP.
8. An active static DNS, static DHCP, or dynamic DHCP allocation cannot be
   classified as rogue.
9. An expired or missing dynamic lease immediately ends dynamic allocation.
   SLAAC authority ends when its valid lifetime expires or the address is
   explicitly withdrawn.
10. Disabled DNS records, reservations, leases, and scopes do not create live
    claims.
11. Scope creation, enabling, or resizing must reject conflicts with static DNS
    allocations and protected addresses before dnsmasq configuration changes.
12. DNS allocation must reject scope membership and any existing incompatible
    allocation before creating the A or AAAA record and its PTR record.
13. Static DHCP creation must reject every incompatible allocation before
    creating the reservation and generated DNS records.
14. Manual reserve/unreserve operations must reject or explicitly transition
    existing DNS, DHCP, and system allocations. They cannot overwrite only a
    display field.
15. IPv6 link-local identities require interface/network context and cannot be
    allocated through global DNS or DHCP without an explicit supported use
    case.
16. DHCPv6 cannot set or infer the default gateway. Router Advertisement and
    explicit network configuration are the only IPv6 gateway authorities.
17. IPv6 temporary/privacy addresses cannot overwrite a stable address for the
    same host. They are distinct address identities that may share device
    metadata through a separate, evidence-based host association.

## Display Rules

Display status is derived in one place after allocation and scope membership
are known.

| Condition | Status | Type |
| --- | --- | --- |
| IPv4 network/broadcast, IPv6 subnet-router anycast, DNS/DHCP server, or appliance service address | `in use` | `system` |
| Configured default gateway | `in use` | `gateway` |
| Static DNS allocation | `in use` | `static DNS` |
| Active dynamic lease | `in use` | `dynamic DHCP` |
| Static DHCP allocation | `in use` | `reserved DHCP` |
| SLAAC allocation within its valid lifetime | `in use` | `SLAAC` |
| Online unassigned host | `in use` | `rogue` |
| Inactive administrative hold | `in use` | `reserved` |
| Unassigned address in enabled scope | `DHCP Scope` | empty |
| Unassigned address outside enabled scope | `available` | empty |

Static assignments remain `in use` while offline. Dynamic DHCP becomes
unassigned when its lease is no longer active. SLAAC remains allocated until
its valid lifetime expires, even if its preferred lifetime has ended and it is
deprecated for new connections. A rogue becomes an unassigned address when its
offline retirement window elapses.

## Lifecycle Transitions

### Administrative reserve

```text
unassigned -> reserved
```

- Reject protected or already allocated addresses.
- If inside a DHCP scope, immediately add the effective dnsmasq exclusion.
- Preserve descriptive metadata and scan preferences.
- Do not mark the address online or set `last_seen_at`.

### Allocate through static DNS

```text
unassigned|reserved -> static_dns
```

- Reject enabled DHCP scope membership.
- Reject any active DHCP allocation or incompatible reservation.
- Create/update A or AAAA records and the IP allocation atomically.
- Set the canonical hostname immediately.
- Do not infer liveness from configuration.

### Allocate through static DHCP

```text
unassigned|reserved -> static_dhcp
```

- Validate a usable host address and the protocol's client identity. DHCPv4
  normally binds a MAC. DHCPv6 can require a DUID/IAID rather than treating a
  MAC as universally authoritative.
- Reject protected or incompatible allocations.
- Create/update the DHCP reservation, generated DNS/PTR data, and IP allocation
  atomically.
- Do not infer liveness from an infinite lease-file entry.

### Obtain or renew a dynamic lease

```text
unassigned -> dynamic_dhcp
dynamic_dhcp -> dynamic_dhcp
```

- Require the address to be in the serving enabled scope.
- Reject reserved, static, system, and gateway addresses.
- Record MAC, lease hostname, lease status, and expiration.
- Treat the DHCP request/acknowledgement as passive liveness evidence: set
  online and refresh `last_seen_at`.
- Remove stale canonical DHCP DNS names when the lease changes address or name.

### Observe or renew SLAAC allocation

```text
unassigned -> slaac
slaac -> slaac
```

- Require the address to belong to the observed IPv6 prefix and interface.
- Record preferred and valid lifetimes when trustworthy Router Advertisement
  or Neighbor Discovery evidence provides them.
- Keep stable and temporary/privacy properties separate from allocation state.
- Treat direct Neighbor Discovery or traffic evidence as liveness, but do not
  infer that every address in an advertised prefix is allocated.
- Reject or report a collision with reserved, static DNS, static DHCPv6,
  dynamic DHCPv6, system, or gateway state.
- Deprecation at the preferred-lifetime boundary does not make the address
  available. Expiration or withdrawal at the valid-lifetime boundary ends the
  SLAAC allocation.

### Active liveness observation

```text
allocation state unchanged
offline -> online
```

- Active ARP/ICMP for IPv4, Neighbor Discovery/ICMPv6 for IPv6, and passive
  DNS/DHCP observations share one operation.
- Refresh online state, `last_seen_at`, observation source, and observed MAC.
- An online unassigned host becomes rogue.
- A legitimate allocation can report a MAC conflict without changing its
  allocation state.

### Offline transition

```text
allocation state unchanged initially
online -> offline
```

- A failed covered scan owns the offline edge for scanned addresses.
- The passive timeout owns it only where no active scanner will do so.
- Preserve `last_seen_at` on static DNS, static DHCP, reserved, system, and
  gateway addresses indefinitely.
- Start a one-hour retirement window for dynamic DHCP, expired SLAAC, and rogue
  metadata.

### Dynamic or rogue retirement

```text
dynamic_dhcp -> unassigned
expired slaac -> unassigned
rogue classification -> unassigned classification
```

After one continuous hour offline:

- Clear `last_seen_at`, observed MAC, dynamic hostname, rogue reason, and other
  address-bound learned metadata.
- Remove the dynamic hostname and IPv4 or IPv6 PTR generated from the lease or
  autonomous-address registration.
- Remove stale dnsmasq lease/sticky association state using a documented,
  testable mechanism.
- Recompute display status as `DHCP Scope` or `available` for DHCP-managed
  space, or `available` for other address space.
- Retain administrator-authored notes and per-IP scan preferences without
  retaining a false allocation.

### Administrative change or deletion

- Rename hostnames immediately in the canonical IP and DNS read models.
- Delete the old generated A or AAAA record and its PTR record in the same
  transaction or
  after-commit unit as the new configuration.
- Removing static DNS or static DHCP immediately transitions to `unassigned`
  unless another explicitly permitted allocation is created in the same
  operation.
- Disabling behaves like removal for live allocation, while preserving the
  disabled protocol configuration row.
- dnsmasq regeneration must occur only after the database transaction commits.

## Proposed Ownership Boundaries

### IP lifecycle service

Introduce one application service as the only entry point for allocation and
liveness transitions. Routes, lease ingestion, scanners, importers, and startup
reconciliation call this service rather than coordinating models themselves.

Responsibilities:

- Load the current IP aggregate.
- Validate the requested transition.
- Update the canonical allocation state.
- Coordinate protocol-detail writes inside one transaction.
- Queue DNS/DHCP regeneration after commit.
- Emit one coherent lifecycle event.

### `ip_addresses`

Canonical owner of address identity, allocation state, canonical hostname/MAC,
liveness, observed metadata, rogue classification, notes, and scan overrides.

The current `status` column should be replaced or migrated to an explicit
allocation-state column. It must not contain display statuses.

### DNS tables

Own DNS protocol details and relationships: zone, RR type, name, value, TTL,
priority, enabled state, and record provenance. Enabled manual A and AAAA
records must be consistent with the IP's `static_dns` allocation.

### DHCP tables

- Scopes own DHCP configuration, protocol family, and address-range membership.
- Reservations own DHCP-specific client identity and configuration for
  `static_dhcp` allocations. A MAC is suitable for DHCPv4. DHCPv6 identity must
  preserve DUID and IAID semantics.
- Leases record dnsmasq's current DHCPv4 or DHCPv6 lease facts and optional
  history.

None of these tables independently decides the IP display type.

### Network topology

Subnets, prefixes, interfaces, and system ranges remain the source for protected
topology identities. For IPv4 this includes network, broadcast, and configured
gateway addresses. For IPv6 it includes subnet-router anycast, interface-local
service addresses, and routers learned from trusted Router Advertisements or
configuration. The aggregate builder projects them as protected IP allocation
states. This is the documented exception to storing all state directly on
`ip_addresses`.

### Client

The client renders canonical server fields. Remove the duplicate lifecycle
decision tree from `client/src/utils/ipLifecycleDisplay.js` after every API read
path supplies the canonical aggregate. Client-side logic may format labels but
must not decide ownership or availability.

## Data Migration and Reconciliation

Migration must be deterministic and must not silently choose between ambiguous
administrative claims.

### Inventory before migration

Produce counts and detailed reports for:

- IPs with more than one enabled allocation claim.
- Manual A records inside enabled DHCP scopes.
- Reservations or leases on system/gateway addresses.
- Locked addresses inside scopes that dnsmasq can currently lease.
- Dynamic leases outside enabled scopes.
- Disabled records that still look active in `ip_addresses`.
- `assigned` rows without a backing manual A record.
- `dhcp` rows without an enabled reservation or active lease.
- Allocated rows still marked rogue.
- Duplicate IP rows across overlapping subnet ownership.
- Noncanonical IPv6 spellings and IPv4-mapped duplicates if any phase-0
  consumers have already persisted them.
- Link-local IPv6 rows lacking interface context.
- AAAA, DHCPv6, or SLAAC facts that cannot map to one canonical address
  identity once those features exist.
- Hostname/MAC disagreements among the IP, lease, reservation, and DNS sources.

### Automatic reconciliation

Safe cases can be repaired automatically:

- Unbacked historical DHCP rows become unassigned history.
- Disabled configuration loses live allocation authority.
- Expired leases lose dynamic allocation authority.
- Valid single claims populate the canonical allocation state.
- IPv4 network/broadcast, IPv6 subnet-router anycast, gateway, and appliance
  addresses become protected.
- Rogue flags are cleared from valid allocations unless a separate MAC-conflict
  event remains active.

### Ambiguous conflicts

Do not resolve competing administrative claims by display precedence. Record
them in a migration-conflict report and either:

- block the upgrade with exact remediation instructions, or
- place the address in a safe quarantined state that neither DNS nor DHCP can
  allocate until an administrator chooses the winner.

The choice between blocking and quarantine is a release-design decision.

### Rollback and backup

- Back up the database before schema migration.
- Keep migrations forward-only and idempotent where possible.
- Do not regenerate dnsmasq configuration until reconciliation succeeds.
- Verify the generated configuration before signalling or restarting dnsmasq.
- Include conflict counts and migration outcome in startup logs and health
  diagnostics without exposing credentials or unrelated host data.

## Implementation Phases

### Phase 1: Lock the contract

Status: complete. Implemented, tested, committed, and pushed in `4f1a4f3`.

Validation: 985 server tests, 133 client tests, ESLint, database ownership
checks, and diff checks passed on 2026-09-02.

- Approve the nine semantic decisions above.
- Write the allocation-state, address-family capability, and display-status
  enums.
- Write a complete transition matrix with allowed sources and side effects.
- Add architecture decision records for normalized protocol tables and topology
  projection.
- Update `docs/API_MODEL.md` to the target contract.

Exit criteria: every current term has one definition and every transition has
one expected result.

### Phase 2: Characterize current behavior

Status: complete. Implemented, tested, committed, and pushed in `9e08ef9`.

Validation: 991 server tests passed with 10 target-behavior cases recorded as
pending, 133 client tests passed, and the commit review found no issues on
2026-09-02.

- Add failing tests for every audited discrepancy before changing behavior.
- Add database fixtures containing each contradictory state.
- Add clean-install, upgrade, backup/restore, and disabled-record fixtures.
- Capture dnsmasq output for reserved IPs inside scopes.
- Add family-neutral fixtures for canonical IPv6, link-local scope, mapped IPv4,
  SLAAC lifetimes, DHCPv6 identity, and the absence of IPv6 broadcast.

Exit criteria: tests reproduce the existing lifecycle failures and distinguish
desired behavior from legacy behavior.

### Phase 3: Canonical schema and aggregate

Status: complete. Implemented, tested, committed, and pushed in `5b8ae94` and
`77cde61`.

Validation: 997 server tests passed with 10 later-phase cases pending, 133
client tests passed, lint and database ownership checks passed, and the final
follow-up review passed on 2026-09-02. The initial review process timed out
after its five-minute limit, so the missed canonical synthesized-row case was
reviewed locally, corrected, and accepted by the follow-up review.

- Add the explicit allocation state and source reference.
- Add canonical address family, sort key, and nullable interface context using
  the phase-0 shared address core.
- Implement the canonical IP aggregate and use it in read-only routes.
- Project scope membership, DNS details, leases, vendor, and topology through
  the aggregate.
- Keep compatibility fields temporarily where external consumers require them.

Exit criteria: Network, DNS, DHCP, host details, search, and sorting agree for
the same address without client inference.

### Phase 4: Central transition service

Status: complete. Implemented, tested, committed, and pushed in `64a69cc`.

Validation: 1,007 server tests passed with 10 later-phase cases pending, 133
client tests passed, lint, database ownership, and diff checks passed on
2026-09-02. The commit review passed and identified the competing DNS and DHCP
claim rejection that Phase 5 implements next.

- Route DNS A-record writes through the lifecycle service.
- Route future AAAA writes through the same lifecycle service rather than an
  IPv6-specific owner.
- Route static DHCP reservation writes through it.
- Route manual reserve/unreserve operations through it.
- Route lease ingestion and expiry through it.
- Define adapters for future DHCPv6 leases, SLAAC lifetimes, Neighbor
  Discovery, and Router Advertisement observations.
- Route active and passive liveness through it.
- Route Pi-hole imports and startup reconciliation through it.

Exit criteria: no application code outside the lifecycle boundary directly
changes canonical IP allocation or liveness fields.

### Phase 5: Enforce DHCP and DNS exclusions

Status: complete. Implemented, tested, committed, and pushed in `88b1ec5` and
`0bd835e`.

Validation: 1,023 server tests passed with the three Phase 6/7 cases pending,
133 client tests passed, lint and database ownership checks passed, and the
commit review findings were corrected and accepted by follow-up review on
2026-09-03.

- Implement reserved-address exclusion in generated dnsmasq configuration.
- Validate leases against enabled scope bounds.
- Reject A or AAAA DNS allocations inside same-family dynamic pools.
- Reject scope creation/enabling/resizing over static DNS allocations.
- Protect system and gateway addresses in every transition direction.
- Ensure DHCPv6 never supplies gateway authority and IPv6 has no broadcast
  assumption.
- Verify dnsmasq configuration before applying it.

Exit criteria: every forbidden combination fails before partial state or config
is written.

### Phase 6: Retirement and cleanup

- Replace the 24-hour DHCP-row and seven-day metadata defaults with the
  specified one-hour continuous-offline rule for dynamic, expired SLAAC, and
  rogue addresses.
- Preserve static assignment observations indefinitely.
- Remove dynamic DNS/PTR and sticky lease associations on retirement.
- Make cleanup idempotent and safe across restarts and clock changes.

Exit criteria: deterministic time-controlled tests cover 59 minutes, 60
minutes, renewed activity, restart during timeout, and static retention.

### Phase 7: Migrate existing installations

- Run the inventory report before mutation.
- Reconcile safe cases transactionally.
- Handle ambiguous conflicts using the approved block-or-quarantine policy.
- Migrate compatibility fields and remove obsolete state writers.
- Regenerate and validate DNS/DHCP configuration.

Exit criteria: representative 0.4.17 databases upgrade without silent data
loss, invalid dnsmasq configuration, or contradictory live claims.

### Phase 8: Remove compatibility logic

- Remove `assigned`, `locked`, and `dhcp` storage semantics after callers move.
- Remove server and client precedence trees that mask conflicts.
- Remove startup self-heals made obsolete by enforced invariants.
- Update operator documentation and API examples.

Exit criteria: one vocabulary, one transition path, and no legacy fallback can
reintroduce split authority.

## Verification Matrix

At minimum, automated tests must cover the following.

| Scenario | Expected result |
| --- | --- |
| Reserve an available address outside a scope | `reserved`, `in use` |
| Reserve an available address inside a scope | excluded from dynamic DHCP |
| Allocate reserved address through DNS outside scope | `static_dns` |
| Allocate reserved address through static DHCP | `static_dhcp` |
| Create static DNS inside enabled scope | rejected, no partial record |
| Create/expand/enable scope over static DNS | rejected, old config retained |
| Dynamic lease inside enabled scope | `dynamic_dhcp`, online, last seen refreshed |
| Dynamic lease outside enabled scope | rejected/quarantined and reported |
| Dynamic lease targets reserved/static/system IP | rejected and conflict recorded |
| Static DHCP targets network/broadcast/gateway | rejected |
| DNS query from assigned host | liveness updated, allocation unchanged |
| DNS query from unassigned host | online rogue |
| DHCP request from assigned client | liveness updated |
| Active scan response from assigned host | online, last seen updated |
| Active scan response from unassigned host | online rogue |
| Failed scan after prior response | offline edge emitted once |
| Dynamic host offline for 59 minutes | metadata retained |
| Dynamic host offline for 60 minutes | returned to scope, metadata/DNS cleared |
| Rogue offline for 60 minutes | returned to scope/available, metadata cleared |
| Static DNS/static DHCP offline indefinitely | last seen preserved |
| Delete static DNS assignment | immediately unassigned and DNS/PTR removed |
| Delete static DHCP assignment | immediately unassigned and generated DNS removed |
| Disable and re-enable configuration | live allocation follows enabled state |
| Concurrent DNS and DHCP allocation attempts | exactly one commits |
| Server restart during transition/cleanup | converges without duplicate events |
| Every API table requests same IP | allocation, status, type, hostname, and liveness agree |
| Equivalent compressed and expanded IPv6 input | one canonical lifecycle identity |
| IPv4 and IPv4-mapped IPv6 input for same endpoint | one canonical IPv4 identity |
| Same IPv6 link-local address on two interfaces | two correctly scoped identities |
| Unscoped link-local address at a persistence boundary | rejected |
| Static AAAA allocation inside enabled DHCPv6 pool | rejected, no partial record |
| Static AAAA allocation outside DHCPv6 pool | `static_dns`, canonical IPv6 stored |
| DHCPv6 lease inside enabled pool | `dynamic_dhcp`, DUID/IAID and lifetime retained |
| DHCPv6 lease outside enabled pool | rejected/quarantined and reported |
| DHCPv6 lease contains router options | does not create gateway authority |
| Trusted Router Advertisement identifies router | protected `gateway` projection |
| SLAAC address before preferred lifetime | `slaac`, preferred, `in use` |
| SLAAC address after preferred but before valid lifetime | `slaac`, deprecated, `in use` |
| SLAAC address after valid lifetime and one hour offline | retired and metadata cleared |
| Temporary and stable IPv6 addresses on one device | distinct IPs, optional shared host association |
| Neighbor Discovery response | IPv6 liveness and last seen updated |
| IPv6 prefix enumeration | no attempt to materialize or scan the full address space |
| IPv6 subnet handling | no broadcast row or broadcast exclusion generated |
| IPv6 reverse record | correct nibble-reversed `ip6.arpa` PTR |

Testing layers:

- Pure transition-table tests.
- Shared address-core canonicalization, containment, sorting, and equivalence
  tests for both families.
- Model and service transaction tests.
- Route differential tests across DNS, DHCP, subnet, and import APIs.
- Schema-enum and database-constraint differential tests.
- Generated dnsmasq configuration tests.
- DHCPv6, Neighbor Discovery, Router Advertisement, and SLAAC adapter contract
  tests when those adapters are introduced.
- Fake-clock cleanup tests.
- Upgrade tests using real pre-migration database fixtures.
- Backup/restore reconciliation tests.
- Client component tests that assert rendering, not lifecycle inference.
- End-to-end browser verification for Network, DNS, DHCP, and host details.

## Operational Observability

- Emit lifecycle events only for real edges and administrative transitions.
- Record why an allocation was rejected without leaking secrets.
- Expose reconciliation conflicts and cleanup counts in diagnostics.
- Distinguish an address conflict from liveness and from allocation state.
- Log dnsmasq configuration validation failures before retaining the prior known
  good configuration.
- Add metrics for allocation counts by state, scope conflicts, rogue hosts,
  retirement actions, and reconciliation failures.

## Security and Reliability Requirements

- Treat lease files, DNS query sources, imported records, and MAC/hostname data
  as untrusted input.
- Validate again at dnsmasq configuration sinks.
- Prevent command and configuration injection in every generated value.
- Bound cleanup batches and database transactions so large subnets do not block
  DNS service for long periods.
- Never enumerate an IPv6 prefix to produce available rows or schedule a full
  address-space scan. IPv6 views must be sparse and observation/allocation
  driven.
- Use database transactions plus after-commit regeneration to prevent config
  from representing rolled-back state.
- Make concurrent allocation attempts serialize on the IP identity and fail
  with a conflict rather than last-writer-wins behavior.
- Preserve private keys, API tokens, databases, leases, and logs outside release
  artifacts. Continue release and backup checks for these files.

## Release Strategy

This work should not land as one unreviewable rewrite.

1. Land contract and characterization tests first.
2. Introduce the family-neutral canonical read aggregate without changing
   writes.
3. Move one write family at a time behind the transition service.
4. Enable constraints only after reconciliation tooling is proven.
5. Exercise upgrade fixtures and dnsmasq output before a prerelease.
6. Validate the prerelease on a disposable appliance with real DNS, DHCP,
   active scanning, passive DNS, lease renewal, and offline retirement.
7. Run the repository's full pre-release and security review pipeline before
   final release.
8. Begin user-visible IPv6 phases only after the lifecycle service and canonical
   aggregate are stable for IPv4. Add IPv6 sources as adapters to that boundary.

Compatibility API fields should have a documented deprecation window if they
are consumed outside the bundled client. Database migration and cleanup changes
must be called out prominently in release notes.

## Completion Criteria

The lifecycle remediation is complete only when:

- Each address has one allocation state and contradictory writes are rejected.
- Address identity and ordering are canonical and indexed for both IPv4 and
  IPv6, including link-local context and IPv4-mapped inputs.
- Reserved addresses inside scopes cannot be dynamically leased.
- Static DNS cannot be created inside enabled scopes in either operation order.
- Dynamic leases cannot exist outside enabled scopes.
- SLAAC and DHCPv6 have explicit lifetime and client-identity semantics, and
  DHCPv6 cannot become the IPv6 gateway authority.
- DHCP and DNS passive activity update liveness through the same operation.
- Dynamic and rogue metadata retires after one continuous hour offline.
- Static assignment observations persist until administrative removal.
- Network, DNS, DHCP, host details, API search, and sorting show the same IP
  facts.
- Disabled records do not create active-looking allocations.
- Upgrade reconciliation reports rather than hides ambiguous claims.
- The client contains no independent allocation-state decision tree.
- Clean install, upgrade, full tests, release build, rendered UI verification,
  and dnsmasq integration checks all pass.
- Subsequent IPv6 features can use the lifecycle boundary without adding a
  second allocation owner or client-side decision tree.
