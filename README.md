
# CIDRella

Have a home network lab and need something better than a spreadsheet to plan and track your networks? Perhaps a small business, or even a medium-sized business. Need integrated address planning, DNS and DHCP all rolled into one, but found other solutions much too complicated (Netbox) or too simple (Pi-hole)? CIDRella is lightweight IP Address Management system that requires minimal system resources (can be deployed as a container or LXC) and minimal learning curve.

Pronounced cider-ella, a lame, near-homophone of Cinderella. Why? It's complicated.

CIDR stands for Classless Inter-Domain Routing. Read about it [here](https://en.wikipedia.org/wiki/Classless_Inter-Domain_Routing).

## Features

- **IP address management** — Hierarchical subnets, folders, VLANs, functional ranges, table/grid views, and a canonical IP state model shared across Networks, DHCP, and DNS.
- **DNS management** — Forward and reverse zones with A, CNAME, MX, TXT, SRV, PTR records, SOA serial management, PTR sync, and direct dnsmasq config generation.
- **DNSSEC validation** — UI toggle that turns on dnsmasq DNSSEC validation against the root trust anchor, with a TCP-capable DNS proxy (so large/signed answers and validating-stub resolvers work) while blocklist + GeoIP filtering stay in place. NTP is enabled automatically and dnsmasq starts lenient on signature timestamps until the clock syncs.
- **Encrypted forwarders (DoT/DoH)** — Optionally encrypt CIDRella→upstream DNS via DNS-over-TLS or DNS-over-HTTPS through a built-in stub (no external daemon), with preset unfiltered resolvers (Cloudflare/Google/Quad9/AdGuard) or custom. Fails closed (no silent plaintext fallback) and stays compatible with DNSSEC validation.
- **DHCP management** — Scopes, global defaults for new scopes, per-scope options, reservations, dynamic lease tracking, and DHCP-derived DNS records.
- **Rogue DHCP detection** — Scheduled active probe (DISCOVER broadcast) that flags unauthorized DHCP servers answering on CIDRella's segments; CIDRella's own server is auto-trusted, with a user allowlist for other legitimate servers. Surfaces a yellow warning on the Ops chip.
- **Liveness and rogue detection** — Passive DHCP/DNS observations plus ARP-first active probes with ICMP fallback, scan history, and rogue IP classification.
- **Passive device/OS fingerprinting** — Identifies each DHCP client's device type and OS family from its DHCP fingerprint (options 55/60 + hostname) and MAC OUI, classified by an offline ruleset. Surfaced as a "Device" column and a per-host "More info" popup. No active scanning, no raw sockets.
- **Analytics** — DNS query, blocked-domain, blocked-host, client/domain pair, and system performance views backed by DuckDB.
- **Blocklists and GeoIP filtering** — Category blocklists, scheduled refresh, whitelisting, and country-based allow/block modes through the DNS proxy.
- **Anomaly detection** — Python sidecar for unusual query volume, new-domain patterns, beaconing, and DGA-like behavior with UI status/health reporting.
- **Pi-hole import** — Standalone Settings workflow for importing Pi-hole DNS records, CNAMEs, DHCP reservations, and upstream DNS settings.
- **Operations and recovery** — Signed native updates, scheduled backups, restore validation, reset-password and reset-web-port tools, log viewing, and audit history.
- **Certificate management** — Self-signed defaults, certificate upload, RSA/ECDSA CSR generation, and certificate/key validation.
- **Role based access control** — Admin, DNS, DHCP, and readonly roles with permission-checked APIs and audited mutations.

---

![CIDRella Networks Page](https://raw.githubusercontent.com/fatcat/cidrella/main/client/public/networks.png)

---

## Host Sizing

CIDRella targets 1–2 GB hosts. Per-IP bookkeeping in SQLite is the dominant memory cost, so very large allocated subnets (e.g. `/10`, `/8`) will outgrow modest hosts long before DHCP lease counts become the bottleneck. See [docs/SIZING.md](docs/SIZING.md) for the ceiling-per-host table and the math behind it.

Developer notes: shared IP state returned to the UI follows the canonical read/write naming contract in [docs/API_MODEL.md](docs/API_MODEL.md). Backend database ownership boundaries are tracked in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installation

> **Use caution**: While no known vulnerabilities exist in this application, it would be unwise to expose its open ports on a public network. Always secure your infrastructure.

> **Only install CIDRella from the official [GitHub releases](https://github.com/fatcat/cidrella/releases).** Starting with v0.4.1, every release tarball is cryptographically signed using [minisign](https://jedisct1.github.io/minisign/). Both the install script and the update script automatically verify the signature before applying changes. This ensures the tarball you are installing was built by the project maintainer and has not been modified. **Do not install or update using a tarball obtained from any other source** — there is no way to verify its authenticity or integrity.

**Cloning the repository** is suitable for development and code review. For production deployments, use the install script or a release tarball — these include the pre-built frontend and are signature-verified.

### Option 1: Automated install (Debian/Ubuntu)

Download and review the install script, then run it:

```bash
curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh -o install.sh
less install.sh    # review before running
sudo bash install.sh
```

The script installs system dependencies, uses the bundled Node runtime from the release tarball, downloads the latest signed release from GitHub, verifies the signature, and configures systemd services. See **[INSTALL-NATIVE.md](INSTALL-NATIVE.md)** for full details.

### Option 2: Docker

For development and testing:

```bash
docker compose up -d
```

See **[INSTALL-DOCKER.md](INSTALL-DOCKER.md)** for full details. Note: in-app updates are not available in Docker — update by pulling the latest image.

## Upgrading

CIDRella checks for new releases on startup and every hour. When an update is available, a blue badge appears in the header bar.

**In-app (native deployments):**
Navigate to **System > Updates** and click **Install Update**. CIDRella will download the release from GitHub, verify the signature, back up the current installation, and apply the update automatically.

**Command line:**
```bash
sudo cidrella-update               # update to latest
sudo cidrella-update --version 0.5.0  # update to specific version
```

The update script (`/opt/cidrella/update.sh`) backs up the current installation, downloads and verifies the signed release tarball, installs dependencies, and restarts services. Database migrations run automatically on startup.

Native updates also refresh the installed systemd units, sudoers/polkit helpers,
logrotate configuration, and recovery scripts. Hosts installed before the
ambient-capability change receive the updated systemd capability configuration
when the installer/update path refreshes the unit files.

**Docker:**
```bash
docker compose pull && docker compose up -d
```

> **Do not apply updates using tarballs downloaded from sources other than the official [GitHub releases](https://github.com/fatcat/cidrella/releases).** Manually extracting an unverified tarball bypasses signature verification and could compromise your network infrastructure.

## Web UI Ports

CIDRella's standard web UI ports are `443` for HTTPS and `80` for the HTTP-to-HTTPS redirect. Ports below `1024` require `CAP_NET_BIND_SERVICE`; the native systemd unit installed by CIDRella includes this capability.

If CIDRella is behind nginx, Traefik, or another reverse proxy, the HTTP redirect can be disabled in **Settings > Interfaces**. When redirect is disabled, CIDRella does not bind the configured HTTP port.

If a web port change makes the UI unreachable, run:

```bash
sudo cidrella-reset-web-ports
```

This clears the stored web port overrides, re-enables the HTTP redirect, and restarts CIDRella so it falls back to the systemd defaults for the host.

## Architecture

| Layer | Technology |
|-------|-----------|
| DNS/DHCP | DNSmasq |
| Backend | Node.js + Express |
| Frontend | Vue 3 + PrimeVue |
| Database | SQLite (better-sqlite3) |
| Database | DuckDB (for analytics and anomaly detection) |
| Custom | DNS proxy (for domain and country blocking) |
| Anomaly Detection | Python sidecar |
| Process Manager | s6-overlay (Docker), systemd (native) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for backend database ownership boundaries, model/service responsibilities, and guardrails.

## Roles

| Role | Description |
|------|-------------|
| admin | Full access to all features |
| dns_admin | Manage DNS records and zones |
| dhcp_admin | Manage DHCP scopes and reservations |
| readonly_dns | View DNS configuration |
| readonly_dhcp | View DHCP configuration |
| readonly | View all configuration |
