# TODO

TODO list for CIDRella

## 0.4.18

- [ ] complete transition to openvue
- [ ] add inline editing of hostnames in the DNS table view
- [ ] reverse DNS, some unused addresses get a placeholder reverse entry and some don't
- [ ] to 'Analytics - Intelligence' add a top 10 domains that don't support DNSSEC
- [ ] to DNS table add popup menu to edit and delete (clear) static DNS records, with confirmation

## 0.5.x
- [ ] implement IPv6 for management, DNS, DHCP and blocklists
- [ ] rework the Analytics page, current implementation is really just a placeholder

# DONE

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

