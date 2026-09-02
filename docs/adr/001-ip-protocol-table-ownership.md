# ADR 001: IP Protocol Table Ownership

Status: accepted

## Context

DNS records, DHCP reservations, and leases contain protocol details that do not
belong in one wide IP row. Those tables historically also implied allocation
state, which allowed different views and writers to disagree.

## Decision

`ip_addresses` owns canonical address identity, mutually exclusive allocation
state, allocation source, liveness, and learned host metadata. DNS and DHCP
tables retain normalized protocol details and history. They may change the IP
aggregate only through the lifecycle service.

The canonical aggregate projects protocol facts for reads. A protocol row is
not a second allocation-state authority.

## Consequences

- DNS and DHCP schemas stay normalized.
- Cross-domain changes require one transaction and lifecycle transition.
- Compatibility projections may expose legacy fields during migration, but no
  writer may use those projections as authority.

