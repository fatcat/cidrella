# IPAM Development Plan

## Phase 1: Foundation [COMPLETE]
- [x] Project structure and build tooling
- [x] Docker container with s6-overlay, DNSmasq, Node.js
- [x] SQLite database with migrations
- [x] JWT authentication with role-based access
- [x] Forced password change on first login
- [x] HTTPS with self-signed cert generation
- [x] Vue 3 UI shell with PrimeVue (login, dashboard, sidebar)
- [x] Audit logging for auth events
- [x] Build and verify container

## Phase 2: Subnet & IP Management [COMPLETE]
- [x] CRUD for subnets with CIDR notation
- [x] Functional ranges (unified with DHCP scopes)
- [x] System setting: default gateway position (first/last)
- [x] System-created range types (Network, Gateway, Broadcast, DHCP Scope, Static)
- [x] User-created range types (CRUD)
- [x] Color-coded IP address grid/map view
- [x] Subnet calculator/divider tool
- [x] Range assignment warnings with override
- [x] Hierarchical supernet/subnet tree with divide workflow
- [x] Subnet states: unallocated (address space) / allocated (configured)
- [x] Binary complement remainder algorithm (optimal CIDR consolidation)
- [x] Config migration on division (gateway, DHCP scopes, ranges, reverse DNS flag)
- [x] Buddy-merge reconsolidation on deletion
- [x] Right-click context menu (Divide, Configure, Edit, View, Delete, Merge)
- [x] Configure dialog with DHCP scope and reverse DNS options
- [x] Subnet calculator moved to System page
- [x] RFC1918 enforcement (supernets must respect reserved range boundaries)
- [x] Auto-generated subnet names with configurable template (%1.%2.%3.%4/%bitmask)
- [x] Settings API (GET/PUT) with System page UI (template, gateway position)
- [x] Real-time dynamic divide preview (no manual preview button)
- [x] Division into N equal subnets (slider/count drives equal split)
- [x] Merge subnets (multi-select siblings, validate contiguous CIDR, preserve gateway)

## Phase 3: DNS [COMPLETE]
- [x] Multiple DNS zone management (forward and reverse)
- [x] Record types: A, CNAME, MX, TXT, SRV
- [x] Automatic PTR record generation (via DNSmasq hostsdir)
- [x] DNSmasq hostsdir config generation (A/PTR, hot-reload)
- [x] DNSmasq conf-dir config generation (CNAME/MX/TXT/SRV)
- [x] Atomic config writes (write-to-tmp, rename)
- [x] SIGHUP for conf-dir changes (only when content changes)
- [x] Upstream forwarder configuration (stored in settings, regenerates dnsmasq.conf)
- [x] Auto-create reverse zone on subnet configure (with create_reverse_dns)
- [x] Record validation per type (A=IPv4, CNAME≠@, MX/SRV needs priority, etc.)
- [x] Duplicate A record and CNAME conflict detection
- [x] DNS management UI (zone list, records table, forwarders)

## Phase 4: DHCP [COMPLETE]
- [x] DHCP scope configuration from functional ranges (dhcp_scopes linked to DHCP Scope ranges)
- [x] DHCP options per scope (gateway, DNS servers, domain name, lease time)
- [x] DHCP reservations (MAC → IP with hostname)
- [x] Lease file monitoring and DB sync (fs.watchFile on dnsmasq.leases)
- [x] DNSmasq config generation (dhcp-range/dhcp-option in conf.d, reservations in dhcp-hostsdir)
- [x] Auto-create DHCP scope on subnet configure (when create_dhcp_scope=true)
- [x] Available ranges endpoint (DHCP Scope ranges without existing scopes)
- [x] DHCP management UI (scopes, reservations, leases tabs)

## Phase 5: Network Intelligence [COMPLETE]
- [x] IP conflict detection (ARP/ping scan)
- [x] Admin-triggered network scans
- [x] Conflict warnings on IP grid (non-blocking)
- [x] Audit log viewer (paginated, filtered, in System page)
- [x] System health dashboard (CPU, memory, disk, service status)

## Phase 6: Filtering & Protection [COMPLETE]
- [x] Domain blocklist source management (CRUD sources, popular lists quick-add)
- [x] Multi-format blocklist parsing (hosts, domains, adblock auto-detect)
- [x] Auto-update scheduler with per-source intervals and deduplication
- [x] DNSmasq native blocking via address=/domain/ directives
- [x] Whitelist management (override blocked domains)
- [x] Paginated domain search with source attribution
- [x] Block page redirect for filtered queries (optional, via blocklist_redirect_ip setting)
- [x] Blocklists UI (Sources, Whitelist, Search tabs with stats summary)

## Phase 8: GeoIP Filtering [COMPLETE]
- [x] GeoIP DNS filtering proxy (Node.js UDP proxy between DNSmasq and upstream)
- [x] DB-IP Lite MMDB country database (auto-download and monthly updates)
- [x] Country-based blocklist/allowlist modes (configurable)
- [x] LRU-cached GeoIP lookups with fail-open design
- [x] DNSmasq integration (automatic upstream routing via proxy)
- [x] GeoIP management UI (country rules, settings, proxy status)
- [x] NXDOMAIN response for blocked queries

## Phase 7: Operations [COMPLETE]
- [x] Backup to single .tar.gz archive (DB + certs + dnsmasq config)
- [x] Restore from backup with validation
- [x] Scheduled automatic backups (daily/weekly/monthly with retention)
- [x] First-run setup wizard (admin account creation, skippable)
- [x] Custom TLS certificate upload via UI (PEM key + cert, openssl validation)
- [x] Certificate info display (subject, issuer, expiry, self-signed detection)
- [x] Reset to self-signed certificate
- [x] Backup & Restore tab in System page
- [x] Certificates tab in System page
