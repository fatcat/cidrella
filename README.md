# IPAM

A lightweight IP Address Management system with integrated DNS and DHCP via DNSmasq.

## Features

- **JWT authentication** — Role-based access control with admin, dns_admin, dhcp_admin, and readonly roles
- **HTTPS** — Self-signed certificate auto-generated on first run
- **Audit logging** — All changes logged with user, action, and timestamp
- **Hierarchical subnet tree** — Create supernets and divide into smaller subnets with an interactive tree view
- **Divide workflow** — Divide any leaf subnet into N equal subnets with a real-time slider preview
- **Subnet states** — "Unallocated" (address space) or "allocated" (configured with name, gateway, VLAN, DHCP, DNS)
- **Config migration** — Dividing an allocated subnet migrates gateway, DHCP scopes, and ranges to the inheriting child
- **Reconsolidation** — Deleting subnets buddy-merges adjacent unallocated blocks back into larger CIDRs
- **Merge subnets** — Ctrl-click to multi-select siblings and merge back into a larger CIDR with gateway preservation
- **Functional ranges** — Define IP ranges (DHCP pools, static, custom) with overlap detection and color coding
- **IP address grid** — Color-coded visual map of all IPs in an allocated subnet with drag-select, shift-click range select, and context menu
- **RFC1918 enforcement** — Supernets validated against reserved range boundaries
- **Name templates** — Auto-generated subnet names from a configurable template (e.g., `MyCo-%1.%2.%3.%4/%bitmask`)
- **DNS zones** — Create and manage forward and reverse DNS zones with enable/disable toggle
- **DNS records** — A, CNAME, MX, TXT, and SRV records with type-specific validation and per-record TTL
- **SOA management** — Editable SOA fields (primary NS, admin email, refresh, retry, expire, minimum TTL) with auto-incrementing serial
- **DNSmasq integration** — Automatic config generation with atomic writes; hostsdir for A/PTR (hot-reload), conf.d for CNAME/MX/TXT/SRV (SIGHUP)
- **Upstream forwarders** — Configure upstream DNS servers from the System settings page
- **Reverse zone auto-creation** — Configuring a subnet with "create reverse DNS" auto-creates the in-addr.arpa zone
- **Subnet calculator** — Standalone tool on the System page for splitting networks

## Quick Start

```bash
docker compose up --build
```

Check the container logs for the generated admin password:

```
========================================
  Default admin account created
  Username: admin
  Password: <generated>
========================================
```

Open `https://localhost:8443` and log in. You will be prompted to change your password.

### Reset Admin Password

```bash
docker compose exec ipam node /app/server/src/reset-password.js
```

To reset a specific user:

```bash
docker compose exec ipam node /app/server/src/reset-password.js <username>
```

The new password will be printed to the console. The user will be forced to change it on next login.

## Architecture

- **Backend**: Node.js + Express
- **Frontend**: Vue 3 + PrimeVue
- **Database**: SQLite (via better-sqlite3)
- **DNS/DHCP**: DNSmasq
- **Process Manager**: s6-overlay
- **Container**: Single Docker container with host networking

## Data

All persistent data is stored in `./data/` (mapped to `/data` inside the container):

- `ipam.db` — SQLite database
- `certs/` — TLS certificates
- `dnsmasq/` — DNSmasq configuration and watched directories
- `backups/` — Backup files
- `blocklists/` — DNS blocklist files

## Ports

| Port | Protocol | Service |
|------|----------|---------|
| 8443 | TCP | HTTPS web UI |
| 8080 | TCP | HTTP (redirects to HTTPS) |
| 53 | TCP/UDP | DNS (DNSmasq) |
| 67 | UDP | DHCP (DNSmasq) |

## Roles

| Role | Description |
|------|-------------|
| admin | Full access to all features |
| dns_admin | Manage DNS records and zones |
| dhcp_admin | Manage DHCP scopes and reservations |
| readonly_dns | View DNS configuration |
| readonly_dhcp | View DHCP configuration |
| readonly | View all configuration |

## Planned Features

- DHCP scope management with lease tracking
- Network scanning and IP conflict detection
- Domain blocklists and GeoIP DNS filtering
- Backup/restore and scheduled backups
- System health monitoring
