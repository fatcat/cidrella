
# CIDRella

A lightweight IP Address Management system with integrated DNS and DHCP suitable for home labs and small to medium commercial deployments.

Pronounced cider-ella, a lame, near-homophone of Cinderella. Why? It's complicated.

CIDR stands for Classless Inter-Domain Routing. Read about it [here](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing).

## Features

- **Hierarchical subnet tree** — Create supernets and divide into smaller subnets with an interactive tree view
- **Divide & merge** — Split subnets with a slider preview; merge adjacent siblings back into larger CIDRs
- **Config migration** — Dividing an allocated subnet migrates gateway, DHCP scopes, and ranges to the inheriting child
- **Reconsolidation** — Deleting subnets buddy-merges adjacent unallocated blocks
- **Functional ranges** — Define IP ranges (DHCP scopes, static, custom) with overlap detection and color coding
- **IP address grid** — Color-coded visual map with drag-select, shift-click range select, and context menu
- **DNS zones** — Forward and reverse zones with A, CNAME, MX, TXT, SRV records and auto-incrementing SOA serial
- **Automatic PTR sync** — A records auto-create/update corresponding PTR records in reverse zones
- **DHCP management** — Scopes, options (global defaults + per-scope overrides), MAC reservations, lease tracking
- **DNSmasq integration** — Atomic config writes, hostsdir hot-reload, conf.d for complex records, SIGHUP signaling
- **Network scanning** — ARP/ping-based liveness scans with configurable intervals and per-subnet/per-IP enable inheritance
- **Interface management** — Bind DNS/DHCP services to specific network interfaces
- **Domain blocklists** — Ad/malware blocking with multiple sources, deduplication, and auto-updates
- **GeoIP DNS filtering** — Country-based DNS filtering with blocklist/allowlist modes
- **Pi-hole import** — Import DNS records, DHCP reservations, and settings from Pi-hole
- **Backup & restore** — Scheduled backups with retention policy, manual download, and upload restore
- **JWT authentication** — Role-based access control with admin, dns_admin, dhcp_admin, and readonly roles
- **HTTPS** — Self-signed certificate auto-generated on first run; custom cert upload supported
- **Audit logging** — All changes logged with user, action, and timestamp
- **In-app update checker** — Periodic check against GitHub releases with UI notification
- **Setup wizard** — Guided first-run setup for interface binding, network creation, and Pi-hole import

![CIDRella Networks Page](https://raw.githubusercontent.com/fatcat/cidrella/main/client/public/networks.png)

## Installation

> **Warning**: While no known vulnerabilities exist in this application it would be unwise to expose its open ports on a public network. Always secure your infrastructure.

Choose your deployment method:

- **[Docker](INSTALL-DOCKER.md)** — Quick start for development and testing
- **[Native (Debian/Ubuntu)](INSTALL-NATIVE.md)** — Recommended for production on bare metal or LXC

## Architecture

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Frontend | Vue 3 + PrimeVue |
| Database | SQLite (better-sqlite3) |
| DNS/DHCP | DNSmasq |
| Process Manager | s6-overlay (Docker), systemd (native) |

## Roles

| Role | Description |
|------|-------------|
| admin | Full access to all features |
| dns_admin | Manage DNS records and zones |
| dhcp_admin | Manage DHCP scopes and reservations |
| readonly_dns | View DNS configuration |
| readonly_dhcp | View DHCP configuration |
| readonly | View all configuration |
