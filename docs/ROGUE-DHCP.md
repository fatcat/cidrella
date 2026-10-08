# Rogue DHCP server detection

CIDRella can detect unauthorized DHCP servers answering on its network
segment(s). A rogue server (misconfigured gear or an attacker) hands clients a
bad gateway/DNS and can silently MITM or break the network. Manage it from
**System → Rogue DHCP** (Security group).

## How it works (active probe)

On a schedule (default every 15 min, configurable 5–1440), and on demand via
**Probe now**, CIDRella:

1. Broadcasts a DHCP `DISCOVER` out each LAN segment (one per interface it
   serves on), with the BOOTP **broadcast flag set** so servers broadcast their
   `OFFER` back. Each interface gets a unique transaction ID so replies map to a
   segment.
2. Listens for `OFFER`s on UDP `:68` for a few seconds.
3. For each offer, identifies the responding server by its **server-identifier
   (option 54)** / source IP and classifies it:
   - **Trusted** if the IP is one of CIDRella's own LAN IPs (auto-trusted, so it
     never flags itself) or is on the user **authorized-servers allowlist**.
   - **Rogue** otherwise → recorded as an event.

It sends `DISCOVER` only, never `REQUEST`, so **no lease is consumed** and the
probe is non-disruptive. Detection is implemented with a single UDP socket and
hand-rolled DHCP packets: no raw sockets, no extra capability beyond the
privileged-port bind CIDRella already does for `:53`, no new dependency.

## Alerting

When an **unacknowledged** rogue is present, the header **Ops chip turns yellow**
(a warning, red stays reserved for an actual service-down condition) and the Ops
popover shows a "Rogue DHCP" row linking to the tab. Acknowledge an event to
silence it (it stays acknowledged even as the rogue persists; clear it to re-arm).

## Limitations

- **L2-scoped.** Only servers in the same broadcast domain as a CIDRella
  interface are visible. A rogue on a different VLAN/segment is invisible unless
  CIDRella has an interface there. Multi-homed hosts get multi-segment coverage.
- **No MAC.** A DHCP `OFFER` received over UDP echoes *our* MAC in `chaddr`; the
  server's real MAC lives in the Ethernet frame, which a UDP socket can't see.
  Rogue servers are therefore identified by **IP**, not MAC. (The allowlist
  accepts an optional MAC for the operator's reference.)
- **Detection only.** CIDRella reports rogues; it can't block them (that needs L2
  switch control, out of scope).
- **Port 68 bind.** Binding `:68` is privileged and can collide with a host DHCP
  client. If it can't bind, detection reports `probeSupported: false` (surfaced in
  the UI) and the backend continues normally. It never crashes.

## IPv6: DHCPv6 servers and Router Advertisements

The same setting and interval run two more detectors. Their events land in the
same list with a `kind` of `dhcpv6` or `ra`; the DHCPv4 probe's events are
`dhcp`.

**DHCPv6 (active).** CIDRella multicasts a DHCPv6 `SOLICIT` to
`ff02::1:2` (UDP 547) out of each DHCP-serving interface that holds a link-local
address and listens on UDP `:546` for `ADVERTISE`s. No Rapid Commit is
requested and no `REQUEST` follows, so nothing is bound. A server is identified
by its **DUID** (server-identifier, option 2) plus the link-local it answered
from; its MAC is read from the kernel neighbor table afterwards, which the
unicast reply just populated. Trusted: any of CIDRella's own addresses, dnsmasq's
own DUID (the `duid` header of its lease file), and the allowlist by IP, DUID or
MAC. A stateless-only DHCPv6 server (information-request) ignores `SOLICIT` and
is not found this way; the router that points clients at it is.

**Router Advertisements (passive).** A rogue RA is the most damaging
IPv6 attack on a LAN (RFC 6104): any host that sends one becomes a default router and
DNS server for every autoconfiguring client. Node cannot send a Router
Solicitation (that needs a raw ICMPv6 socket), so CIDRella reads what the kernel
learned: with `accept_ra` on, every RA heard on the link becomes a default route
tagged `proto ra` for the advertised router lifetime, and routers re-advertise
well inside it. `ip -6 route show proto ra` gives the router's link-local, the
interface, and the prefixes advertised there. Trusted: CIDRella's own addresses,
the allowlist by link-local or MAC, and the MAC of any router the operator has
configured as a network gateway (learned by scans), so the real default router
is not flagged on the first check.

Both run only while the IPv6 switch (Settings > General > Interfaces) is on.
Off, `GET /api/dhcp/rogue/status` reports each with `disabled: true` and
`POST /api/dhcp/rogue/probe` runs the DHCPv4 probe alone. On the page, the
Detection block shows one line per IPv6 detector (last probe, unavailable with
the reason, or off), the events table names each finding's kind (DHCPv4,
DHCPv6, Router) with the DUID or MAC and advertised prefixes, and the
authorized list takes an IP of either family, a MAC or a DUID.

Limits:

- RA detection needs `accept_ra` on the interface (`2`, or `1` with forwarding
  off). Interfaces where it is off are reported as unsupported in
  `routerAdvertisements.unsupportedInterfaces` rather than as clean.
- The kernel keeps a router only for its advertised lifetime and does not
  record RDNSS, so the event carries prefixes but not the DNS servers the RA
  pushed.
- Port 546 has the same bind caveat as 68. A host with no IPv6 reports the
  DHCPv6 probe as unsupported and the DHCPv4 probe keeps running.
- Detection only, like DHCPv4. Blocking rogue RAs is RA Guard on the switch.

## Verifying

1. Enable detection (or use **Probe now**); confirm CIDRella's own DHCP server is
   **not** listed.
2. Stand up a second DHCP server on the segment (or run
   `nmap --script broadcast-dhcp-discover` to confirm what answers); it should
   appear as rogue, and the Ops chip should go **yellow**.
3. Add it to the authorized list → it clears on the next probe.
4. For IPv6, `radvd` or `dnsmasq --enable-ra` on a spare host should appear as a
   `ra` event within one interval (the kernel must accept RAs on that
   interface); a second DHCPv6 server appears as `dhcpv6` with its DUID.
