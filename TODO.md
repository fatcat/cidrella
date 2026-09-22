# TODO

TODO list for CIDRella

## 0.5.x

- [x] complete transition to openvue
- [x] revive the setup wizard (landed 2026-09-19 as the four-step first run at `/setup`:
      password, deployment, import, review; the dead account wizard was removed)
- [x] implement IPv6 for management, DNS, DHCP and blocklists (backend and rogue DHCPv6/RA
      detection landed 2026-09-17, the UI pass with the global IPv6 switch 2026-09-18; what is
      left is in BACKLOG.md under "IPv6, in flight")
- [ ] rework the Analytics page, current implementation is really just a placeholder
- [ ] self-service address requests (agreed shape 2026-09-22, not started). A range opts in
      with a `self_service` flag; a requester names a range (not a type, the same type can
      exist in several networks) and a hostname, and supplies a MAC. The allocation is a DHCP
      reservation in that range plus the hostname, made through the lifecycle service, so the
      host gets IP, mask and gateway from DHCP and "renews" by existing; no reaper needed.
      Cleanup is a report of reservations with no lease activity for N days (per-range N with a
      global default), reclaim is a decision from that report, never automatic on a timer
      alone. A `requester` role with one scope, `self-service:write`, that can create, renew
      and release only its own allocations in self-service ranges and read the networks they
      live in; service accounts via the existing API tokens under that role. Endpoints:
      `POST /api/self-service/allocations {range_id, hostname, mac}`, `GET` (own), `DELETE`
      (release), plus the reservations-inactive report. Externally facing, so: rate limit per
      token and per source, per-range cap on allocations per requester, hostname validator and
      zone uniqueness, MAC uniqueness across the network, audit every request/release/reclaim
      (range writes are not audited today either; add that), no enumeration of networks or
      ranges the role cannot allocate in, and the OWASP API top ten on the route. UI: one
      page, pick network then range, hostname, MAC, submit; below it your allocations with
      last lease activity and Release. Ranges tab stays as the pool manager; drop its topology
      rows.

# DONE

## 0.4.18

- [x] add inline editing of hostnames in the DNS table view
- [x] reverse DNS, some unused addresses get a placeholder reverse entry and some don't
- [x] to 'Analytics - Intelligence' add a top 10 domains that don't support DNSSEC
- [x] to DNS table add popup menu to edit and delete (clear) static DNS records, with confirmation

## 0.4.17 (in pre-release)

- [x] phase 1 transition off primevue
- [x] complete function consolidation
- [x] remove the settings card page

## v0.4.16
- [x] dnssec support added
- [x] rogue DHCP server detection
- [x] add shared allowlist for geoip/content blocking
- [x] add passive OS info gathering and store as host metadata
- [x] add forwarder protocol DNS over TLS, HTTPS etc.
- [x] add "do not recurse" setting for DNS
- [x] add theme selector to user dropdown in upper right corner

