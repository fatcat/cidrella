
# CIDRella

Have a home network lab and need something better than a spreadsheet to plan and track your networks? Perhaps a small business, or even a medium-sized business. Need integrated address planning, DNS and DHCP all rolled into one, but found other solutions much too complicated (Netbox) or too simple (Pi-hole)? CIDRella is lightweight IP Address Management system that requires minimal system resources (can be deployed as a container or LXC) and minimal learning curve.

Pronounced cider-ella, a lame, near-homophone of Cinderella. Why? It's complicated.

CIDR stands for Classless Inter-Domain Routing. Read about it [here](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing).

## Features

- **DNS Management** — Forward and reverse zones with A, CNAME, MX, TXT, SRV records and auto-incrementing SOA serial. Automatic generation of PTR reverse-DNS zones
- **DHCP management** — Scopes, options (global defaults + per-scope overrides), MAC reservations, lease tracking
- **Domain blocklists** — Ad/malware blocking with multiple categories and auto-updates
- **GeoIP DNS filtering** — Country-based DNS filtering with blocklist/allowlist modes
- **Anomaly Detection** — Unusual host resolution or query frequency, DGA detection, beaconing detection
- **Analytics** — Visualize DNS query data, Top 10 activity, system performance
- **Network & Domain Inheritance** — Dividing an allocated subnet migrates gateway, DHCP scopes, and ranges to the inheriting child
- **Functional ranges** — Define IP ranges (DHCP scopes, static, custom) with overlap detection and color coding
- **IP address grid** — Color-coded visual map with drag-select, shift-click range select, and context menu
- **Network scanning & Rogue Detection** — ARP/ping-based liveness scans with configurable intervals and per-subnet/per-IP enable inheritance
- **Pi-hole import** — Import DNS records, DHCP reservations, and settings from Pi-hole
- **Backup & restore** — Scheduled backups with retention policy, manual download, and upload restore
- **Role based access control** — RBAC with admin, dns_admin, dhcp_admin, and readonly roles
- **In-app update checker** — Periodic check against GitHub releases with UI notification
- **Setup wizard** — Guided first-run setup for interface binding, network creation, and Pi-hole import

---

![CIDRella Networks Page](https://raw.githubusercontent.com/fatcat/cidrella/main/client/public/networks.png)

---

## Installation

> **Warning**: While no known vulnerabilities exist in this application it would be unwise to expose its open ports on a public network. Always secure your infrastructure.

Choose your deployment method:

- **[Docker](INSTALL-DOCKER.md)** — Quick start for development and testing
- **[Native (Debian/Ubuntu)](INSTALL-NATIVE.md)** — Recommended for production on bare metal or LXC

## Architecture

| Layer | Technology |
|-------|-----------|
| DNS/DHCP | DNSmasq |
| Backend | Node.js + Express |
| Frontend | Vue 3 + PrimeVue |
| Database | SQLite (better-sqlite3) |
| Database | DuckDB (for analytics and anomaly detection) |
| Custom | DNS proxy (for domain and country blocking) |
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
