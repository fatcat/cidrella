
# CIDRella

A lightweight IP Address Management system with integrated DNS and DHCP suitable for home labs and small to medium commercial deployments.

Pronounced cider-ella, a lame, near-homophone of Cinderella. Why? It's complicated.

CIDR stands for Classless Inter-Domain Routing. Read about it [here](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing)

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
- **Functional ranges** — Define IP ranges (DHCP scopes, static, custom) with overlap detection and color coding
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
- **In-app update checker** — Periodic check against GitHub releases with UI notification

## Installation

<b>WARNING</b>: While no known vulnerabilities exist in this application it would be unwise to expose it's open ports on a public network. Always secure your infrastructure.

### Option 1: Docker Compose

```bash
git clone https://github.com/fatcat/cidrella.git
cd cidrella
docker compose up -d --build
```

### Option 2: Native Install (Debian/Ubuntu — recommended for production)

CIDRella runs natively on Debian/Ubuntu with systemd. Choose one of the following methods:

#### Method A: Clone and install

```bash
git clone https://github.com/fatcat/cidrella.git
cd cidrella
sudo bash scripts/install.sh
```

#### Method B: Download and review first

```bash
curl -sSLO https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh
less install.sh        # review the script
sudo bash install.sh   # if deemed benign
```

#### Method C: One-line install

This install method, while fast and easy, is potentially a real headache. If I or an unknown malefactor injects hostile code into this script it will execute with root permissions. 

Obviously this would be Bad (tm).

It is strongly advised you do not use this method and instead use Method B above but only after thoroughly reviewing not only the install script but every line of source code in this app, and that of its external dependencies including the operating system, its libraries and dependencies, compilers and so on. Probably the hardware and firmware too, to be thorough. If you're still alive after completing the review and find no problems, you are good to go!

```bash
curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
```

#### Install a specific version

```bash
sudo bash install.sh --version 0.1.0
```

The installer is interactive and will:

- Install Node.js 20+ (via NodeSource) if not present
- Install system dependencies (dnsmasq, build-essential, nmap, arping, etc.)
- Detect and handle conflicts with systemd-resolved (port 53)
- Handle existing dnsmasq installations (replace config, include config, or skip)
- Create a `cidrella` system user and data directory at `/var/lib/cidrella`
- Download and extract the latest release to `/opt/cidrella`
- Install and start systemd services

### First Login

Check the logs for the generated admin password:

```bash
# Docker
docker compose logs cidrella | grep Password

# Native
journalctl -u cidrella --no-pager | head -20 | grep Password
```

```
========================================
  Default admin account created
  Username: admin
  Password: <generated>
========================================
```

Open `https://<your-server-ip>:8443` and log in. A setup wizard will guide you through initial configuration.

## Updating

### Docker

```bash
cd cidrella
git pull
docker compose up -d --build
```

### Native

```bash
# Update to latest
sudo cidrella-update

# Update to specific version
sudo cidrella-update --version 0.2.0
```

The update script will:
- Back up the current installation
- Download and extract the new release
- Install updated dependencies
- Update systemd units if changed
- Restart services
- Database migrations run automatically on startup

CIDRella also checks for updates in the background and shows a notification badge in the header when a new version is available.

## Configuration

### DNS

DNS works automatically through dnsmasq:

- **Forward DNS records** created in the UI are written to hostsdir (hot-reload — no restart needed)
- **Reverse DNS** (PTR records) are handled automatically by dnsmasq's hosts file format
- Point your clients' DNS to the CIDRella server's IP address (via DHCP option 6, or manually)

### DHCP

DHCP is configured entirely through the UI:

1. Create a network (e.g. `192.168.1.0/24`)
2. Configure it (set gateway, domain name, etc.) — a DHCP scope is auto-created
3. Set DHCP options (DNS servers, NTP, domain search, etc.) on the DHCP settings page
4. The app writes config to dnsmasq conf.d and signals dnsmasq automatically

**Important**: Ensure no other DHCP server is running on the same broadcast domain.

### TLS Certificates

A self-signed certificate is auto-generated on first run. To use your own:

```bash
# Docker
cp cert.pem key.pem data/certs/
docker compose restart

# Native
cp cert.pem key.pem /var/lib/cidrella/certs/
sudo systemctl restart cidrella
```

### Networking

CIDRella requires the following ports:

| Port | Protocol | Service |
|------|----------|---------|
| 53 | TCP/UDP | DNS |
| 67 | UDP | DHCP server |
| 8443 | TCP | Web UI (HTTPS) |
| 8080 | TCP | Web UI (HTTP redirect) |

Docker runs with `network_mode: host` for DHCP broadcast support. Native installs bind directly.

### User/Group Ownership (Docker only)

By default the container runs as root and files in `./data/` will be root-owned. To have data files owned by your host user:

```bash
PUID=$(id -u) PGID=$(id -g) docker compose up -d --build
```

Or add to a `.env` file:

```
PUID=1000
PGID=1000
```

### Timezone

Set the `TZ` environment variable to any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones):

```bash
# Docker
TZ=America/New_York docker compose up -d

# Native: edit the systemd unit
sudo systemctl edit cidrella
# Add: Environment=TZ=America/New_York
```

### Backups

All persistent data lives in the data directory:

| Path | Docker | Native |
|------|--------|--------|
| Database | `data/cidrella.db` | `/var/lib/cidrella/cidrella.db` |
| Certificates | `data/certs/` | `/var/lib/cidrella/certs/` |
| DNSmasq config | `data/dnsmasq/` | `/var/lib/cidrella/dnsmasq/` |
| Backups | `data/backups/` | `/var/lib/cidrella/backups/` |
| Blocklists | `data/blocklists/` | `/var/lib/cidrella/blocklists/` |

The UI also provides database backup/restore under System settings.

## Administration

### Reset Admin Password

```bash
# Docker
docker compose exec cidrella node /app/server/src/reset-password.js

# Native
cd /opt/cidrella && sudo -u cidrella DATA_DIR=/var/lib/cidrella node server/src/reset-password.js
```

To reset a specific user, append the username:

```bash
docker compose exec cidrella node /app/server/src/reset-password.js <username>
```

### Database Reset (Docker)

```bash
docker compose run --rm reset
docker compose restart cidrella
```
There is also a database reset button on the "Settings - Backup and Restore" page.

This deletes the SQLite database and reinitializes it on next startup. A new default admin account will be generated.

The following are **not** deleted and persist on disk:
- TLS certificates
- DNSmasq configuration (regenerated on startup)
- Backup archives
- Downloaded blocklist files

### Service Management (Native)

```bash
# Check status
sudo systemctl status cidrella
sudo systemctl status cidrella-dnsmasq

# View logs
journalctl -u cidrella -f
journalctl -u cidrella-dnsmasq -f

# Restart
sudo systemctl restart cidrella
sudo systemctl restart cidrella-dnsmasq
```

## Architecture

- **Backend**: Node.js + Express
- **Frontend**: Vue 3 + PrimeVue
- **Database**: SQLite (via better-sqlite3)
- **DNS/DHCP**: DNSmasq
- **Process Manager**: s6-overlay (Docker), systemd (native)
- **Deployment**: Docker container or native Debian/Ubuntu

## Roles

| Role | Description |
|------|-------------|
| admin | Full access to all features |
| dns_admin | Manage DNS records and zones |
| dhcp_admin | Manage DHCP scopes and reservations |
| readonly_dns | View DNS configuration |
| readonly_dhcp | View DHCP configuration |
| readonly | View all configuration |
