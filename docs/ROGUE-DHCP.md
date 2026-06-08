# Rogue DHCP server detection

CIDRella can detect unauthorized DHCP servers answering on its network
segment(s). A rogue server — misconfigured gear or an attacker — hands clients a
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

It sends `DISCOVER` only — never `REQUEST` — so **no lease is consumed** and the
probe is non-disruptive. Detection is implemented with a single UDP socket and
hand-rolled DHCP packets — no raw sockets, no extra capability beyond the
privileged-port bind CIDRella already does for `:53`, no new dependency.

## Alerting

When an **unacknowledged** rogue is present, the header **Ops chip turns yellow**
(a warning — red stays reserved for an actual service-down condition) and the Ops
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
  switch control — out of scope).
- **Port 68 bind.** Binding `:68` is privileged and can collide with a host DHCP
  client. If it can't bind, detection reports `probeSupported: false` (surfaced in
  the UI) and the backend continues normally — it never crashes.
- IPv4/DHCPv4 only; DHCPv6 is out of scope.

## Verifying

1. Enable detection (or use **Probe now**); confirm CIDRella's own DHCP server is
   **not** listed.
2. Stand up a second DHCP server on the segment (or run
   `nmap --script broadcast-dhcp-discover` to confirm what answers); it should
   appear as rogue, and the Ops chip should go **yellow**.
3. Add it to the authorized list → it clears on the next probe.
