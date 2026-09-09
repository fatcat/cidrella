# ADR 002: IP Topology Projection

Status: accepted

## Context

Network, broadcast, subnet-router anycast, and gateway addresses are defined by
topology. Duplicating those definitions as editable IP assignments would create
competing ownership.

## Decision

Subnets, prefixes, and configured or trusted learned routers remain the source
of topology identity. The canonical IP aggregate projects the IPv4 network and
broadcast addresses and IPv6 subnet-router anycast as protected `system`
allocations, and router addresses as protected `gateway` allocations.

IPv4 broadcast protection applies only to IPv4. IPv6 gateway authority comes
from explicit configuration or trusted Router Advertisement data, never from
DHCPv6. Link-local IPv6 identity includes interface context.

An enabled manual address record may give a gateway its canonical hostname and
PTR value without replacing topology as the allocation authority. CIDRella
interface and service addresses are not topology allocations: an enabled
manual A or AAAA record owns them as ordinary `static_dns` allocations. DNS and
DHCP service roles are independent capabilities, not allocation types.

## Consequences

- Topology changes must reconcile affected IP projections transactionally.
- System and gateway addresses cannot be allocated by DHCP. DNS may name a
  configured gateway without allocating it. A CIDRella service address is
  protected from DHCP only by its ordinary static DNS allocation.
- IPv6 support must not materialize every address in a prefix.
