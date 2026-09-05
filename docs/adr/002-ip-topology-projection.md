# ADR 002: IP Topology Projection

Status: accepted

## Context

Network, broadcast, subnet-router anycast, gateway, and appliance addresses are
defined by topology. Duplicating those definitions as editable IP assignments
would create competing ownership.

## Decision

Subnets, prefixes, interfaces, and configured or trusted learned routers remain
the source of topology identity. The canonical IP aggregate projects these
facts as protected `system` or `gateway` allocation states.

IPv4 broadcast protection applies only to IPv4. IPv6 gateway authority comes
from explicit configuration or trusted Router Advertisement data, never from
DHCPv6. Link-local IPv6 identity includes interface context.

An enabled manual address record may give a gateway or appliance service
address its canonical hostname and PTR value. That naming metadata does not
replace topology as the allocation authority.

## Consequences

- Topology changes must reconcile affected IP projections transactionally.
- System and gateway addresses cannot be allocated by DNS or DHCP. DNS may
  name configured gateways and appliance service addresses without allocating
  them.
- IPv6 support must not materialize every address in a prefix.
