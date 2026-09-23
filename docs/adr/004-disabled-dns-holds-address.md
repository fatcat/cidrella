# ADR 004: A Disabled DNS Record Holds Its Address

Status: accepted (2026-09-23)

## Context

The lifecycle plan treated a disabled DNS record as non-authoritative: it was
kept for re-enabling but did not allocate, protect, or classify its address.
The address fell back to unassigned, so it could be retired or offered as free,
and a host still answering there was reported as rogue. In production that
flagged hass.the-mcnultys.org, whose A record had been disabled, as a rogue
device.

Disabling a record instead of deleting it says "keep this, do not publish it
right now": a migration, a host that is down for repair, a name parked for
later. Treating it as absent loses that intent. Treating it as a live
`static_dns` claim would describe a name that does not resolve.

## Decision

A manual A or AAAA record that exists but is not served, because the record or
its forward zone is disabled, **holds** its address:

- The address takes allocation state `reserved` with
  `allocation_source_type = 'dns'` and `allocation_source_id` = the record. It
  is not `static_dns`: nothing answers for the name.
- A hold protects the address as an IP Reservation does. It is not retired, not
  offered as available, and an online host there is not rogue.
- Precedence is unchanged above it. Topology, a DHCP Reservation, an enabled
  record, a live lease, and an administrator's IP Reservation all win over a
  hold. A record inside an enabled DHCP scope does not hold, since the pool owns
  those addresses.
- Deleting the record, or deleting its zone, releases the hold. If another
  unserved record still names the address, the hold moves to it.
- An IP Reservation request cannot replace or release a hold, and a DNS change
  cannot release an administrator's IP Reservation. Each `reserved` row is
  released only by its owner, identified by `allocation_source_type`.
- The read model shows a hold as address type `disabled DNS`.

`reconcileDnsHolds` in the lifecycle service applies this rule to every manual
address record. Routes call it after DNS writes, and startup calls it after
migrations, so existing installs and restored backups converge without a
schema change.

## Consequences

- `reserved` has two owners: `admin_reservation` and `dns`.
- Disabling a record no longer frees its address. Deleting it does.
- The Dashboard rogue count and the scanner stop reporting hosts at held
  addresses.
