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
- [x] add shared whitelist for geoip/content blocking
- [x] add passive OS info gathering and store as host metadata
- [x] add forwarder protocol DNS over TLS, HTTPS etc.
- [x] add "do not recurse" setting for DNS
- [x] add theme selector to user dropdown in upper right corner

