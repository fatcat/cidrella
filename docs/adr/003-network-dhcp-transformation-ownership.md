# ADR 003: Network and DHCP Transformation Ownership

Status: accepted

## Context

Network split, carve, and merge operations historically used separate transfer
paths. They could update CIDRs and range rows while leaving canonical IP roles,
DHCP routers, scopes, pools, and leases attached to obsolete networks.

## Decision

Network transformations are one transaction owned by the subnet topology
service. The network model owns CIDR and persistent gateway policy. The IP
lifecycle service owns the resulting network, broadcast, and gateway allocation
projection. DHCP models own scopes, configured pool intervals, reservations,
leases, and effective options.

Gateway policy is `first`, `last`, `custom`, or `none`. Global defaults only
initialize an independent network. First, last, and none policies are inherited
by every split result and preserved by compatible merges. Network topology owns
DHCP mask, router, and broadcast values.

Every transformation must preserve each source fact by moving it to exactly one
target or report an exact blocking conflict before mutation. Preview and execute
must use the same deterministic plan and revision snapshot.

Transformation preview is authorized by `subnets:read`. Applying a split,
carve, or merge is authorized by `subnets:write`. In the current role model only
the administrator wildcard has `subnets:write`, so a DHCP- or DNS-only
administrator cannot use topology mutation to change records outside that
role's scope. Exact conflict resolutions are limited to identities returned by
the current plan and do not grant a broader delete permission. A future role
that receives `subnets:write` must be reviewed as a compound topology operator,
or the product must introduce a dedicated topology permission first.

## Consequences

- Routes validate requests and permissions but do not implement transfer rules.
- Topology projection cannot be repaired with range colors alone.
- All scopes, pool gaps, reservations, and leases participate in split and merge.
- Generated DHCP/DNS application has durable pending, applied, and failed state.
- Conflicting policies or active claims require an explicit resolution.
- DHCP and DNS permissions remain authoritative for their direct CRUD APIs;
  they do not independently authorize topology transformations.
