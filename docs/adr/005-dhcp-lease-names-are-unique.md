# ADR 005: A DHCP Lease Name Is Unique and Sticky in Its Zone

Status: accepted (2026-10-01)

## Context

A DHCP client names itself, and nothing stops two clients from using the same
name. In production two TP-Link Deco XE75 mesh units both asked for
`deco-XE75`. dnsmasq gives a lease name to whichever client renewed last and
writes `*` for the other, so the name moved between 10.0.0.161 and 10.0.0.216
on every renewal. The address that lost the name fell back to its vendor name,
`tplink-device`. Each move rewrote the A records and swapped the two PTRs in the
reverse zone, and since a reverse-zone change restarts dnsmasq, DNS and DHCP
restarted 33 times an hour.

Two unnamed clients from one vendor collide the same way: both get the same
vendor fallback name.

## Decision

The name a lease carries is its **effective name**, decided once when leases
are read from dnsmasq and before they are stored. DNS records, PTRs,
`dhcp_leases.hostname` and the canonical hostname all use it.

- **Sticky.** An address keeps the DHCP-derived name it holds while its lease
  lasts. A client that sends no name keeps the name its address holds; the
  vendor fallback applies only to an address that holds none. A client that
  sends the base of the name its address holds (`deco-XE75` for
  `deco-xe75-00`) keeps the name it has.
- **Unique.** A name is taken in a forward zone when another address holds it:
  an A or AAAA record of the same family pointing elsewhere, or a CNAME. A
  client whose name is taken gets the first free of `-00` through `-FF` in hex
  (`deco-XE75-00`). If all 256 are taken, the lease gets no name and the
  intake logs a warning.
- **Deterministic.** Leases that keep their name are settled first; the rest
  claim names in address order.

Operator-chosen names are not renamed: a DHCP Reservation's name or a manual
record's name only makes a name taken for leases.

Amended 2026-10-21:

- **A client's own lapsed name is not taken.** A name held only by a DHCP
  lease record whose lease has lapsed, at an address whose last-seen MAC is
  the asking client's, goes back to that client on its new address, and the
  old record is removed at once so the name never answers with both. A
  DHCPv4 client is known by its MAC. A DHCPv6 address keeps no MAC (the MAC
  a DUID embeds names a client but is never stored) and loses its DUID when
  the lease lapses, so a returning DHCPv6 client still takes a suffix.
- **A lapsed lease's record does not outlive it.** When a lease lapses while
  its host is online, its name goes at once (the hostname rule in
  ARCHITECTURE.md), and so do the record and PTR it made. Otherwise the record
  is removed when the address retires after its hour offline, and an address
  still named by such a record stays a retirement candidate until it is. A
  record whose address has no row and no lease goes once the lease sync has
  left it untouched for that hour.

## Consequences

A renewal no longer moves a name, so it changes no record and restarts
nothing. Two clients sending one name resolve as `name` and `name-00` and show
those names in every table. When a holder's lease and its one-hour retention
end, its name becomes free; a client already on a suffixed name keeps it
rather than moving.

Before the 2026-10-21 amendment, a client that came back on a new address
found its own old record holding its name and took the next suffix, and a
lease that lapsed with its host online left a record nothing removed. Under a
server that hands a returning client the next free address (Kea's default),
one laptop collected `name` and `name-00` through `name-13` in two weeks.
Retirement now removes those leftover records as well, and CIDRella now has
Kea hold a lapsed lease for a week and give its client the same address back
(ARCHITECTURE.md, backend stacks), so a returning client, DHCPv6 included,
usually finds its address and its name again.
