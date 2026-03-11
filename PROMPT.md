# Project Prompt

Build a single-container, self-hosted IP Address Management (IPAM) system called **CIDRella** with integrated DNS and DHCP services. It should also support native (bare-metal/LXC) deployment via systemd.

## Tech Stack

- **Backend:** Node.js with Express.js (ES modules)
- **Frontend:** Vue 3 with PrimeVue component library, Pinia state management, Vue Router, Axios
- **Database:** SQLite via better-sqlite3 (synchronous, WAL mode, no external DB)
- **DNS/DHCP:** DNSmasq (bundled in container, or system-installed for native)
- **Build:** Vite for frontend, multi-stage Docker build
- **Process Manager:** s6-overlay (Docker) or systemd (native)
- **Base Image:** Alpine Linux (Docker)
- **Deployment:**
  - **Docker:** Docker Compose with host networking, single `/data` volume for all persistent state
  - **Native/LXC:** Install script for Debian/Ubuntu, systemd services, data at `/var/lib/cidrella`, app at `/opt/cidrella`

## Authentication & Authorization

- JWT-based authentication with bcrypt password hashing
- First-run setup wizard that creates the admin account (skippable, auto-generates one)
- Forced password change on first login (`must_change_password` flag)
- Role-based access control: `admin`, `dns_admin`, `dhcp_admin`, `readonly_dns`, `readonly_dhcp`, `readonly`
- Admin-only user management (create, delete, role assignment, password reset)
- Audit logging of all user actions with timestamp, user, action, entity type, and JSON detail payload
- HTTPS with self-signed certificate generation on first run; supports custom cert upload
- Helmet.js security headers, CORS

## Setup Wizard

Three-step guided setup on first run:

1. **Interface selection** — discover host network interfaces, bind DNS/DHCP services to selected interfaces
2. **Network creation** — configure first subnet (CIDR, name, gateway, domain, DHCP scope, VLAN, scan enable)
3. **Pi-hole import** (optional) — import DNS records, DHCP reservations, and settings from an existing Pi-hole instance

Wizard can be skipped at any step. Completion tracked via `setup_wizard_completed` setting.

## Network Interface Management

- Enumerate host network interfaces via `os.networkInterfaces()` and `/sys/class/net/`
- Filter out virtual/internal interfaces (lo, br*, veth*, docker*, virbr*, tun*, tap*)
- Display interface state (up/down/missing) and MAC addresses
- Global DNS and DHCP service toggles — when enabled, mirror to all available interfaces
- Per-interface DNS and DHCP toggles (DHCP requires DNS; disabling DNS auto-disables DHCP)
- DNSmasq integration: generates `listen-address=`, `no-dhcp-interface=`, and `port=0` directives
- Loopback listening on both `127.0.0.1` and `::1` (when IPv6 available)

## Subnet Management

- Hierarchical subnet tree with supernet/subnet relationships
- Subnets have: CIDR, name, description, VLAN, gateway address, status (`allocated` / `unallocated`), depth, folder assignment
- **Folders** for optional logical grouping of root subnets with sort order and drag-and-drop reordering
- **VLANs** defined per folder (IDs 1-4094, unique within folder); can be created without immediate subnet assignment
- RFC1918 enforcement for supernets
- Configurable name template with variable substitution (e.g., `%1.%2.%3.%4/%bitmask`)
- Default gateway position setting (first or last usable IP)

### Subnet Operations

- **Divide:** Split a leaf subnet into N equal child subnets by target prefix length (max 256 children). Preview endpoint shows results before committing. Config migration: the child containing the parent's gateway inherits all configuration (gateway, VLAN, description, DHCP scopes, ranges, reverse DNS). Parent becomes unallocated intermediary.
- **Carve:** Divide by specifying a single child CIDR; binary complement algorithm generates remainder subnets.
- **Merge:** Combine 2+ adjacent sibling subnets into one. Validates buddy-merge compatibility. If merged CIDR reconstitutes the parent, parent becomes a leaf again. Config preserved from the subnet containing the gateway.
- **Delete:** Removing an unallocated leaf triggers buddy-merge reconsolidation with adjacent unallocated siblings.
- **Configure/Allocate:** Set name, gateway, VLAN, optionally create reverse DNS zone and DHCP scope in one operation.
- **Consolidate Intermediate:** After divide, if all siblings of the parent are also intermediaries, flatten the tree.

### Functional Ranges

- IP ranges within subnets with start/end IP, type, color, and description
- 5 system range types (immutable): Network, Gateway, Broadcast, DHCP Scope, Static
- Custom user-created range types with color
- Overlap detection with optional force override
- System ranges (Network/Broadcast) auto-created when a subnet is created or allocated; cannot be manually edited or deleted
- Gateway range created/updated when gateway address is set

### IP Address Management

- Virtual IP generation for every address in a subnet (not pre-stored; generated on demand with server-side pagination)
- Persisted `ip_addresses` table for IPs with assigned metadata (status, hostname, MAC, online tracking)
- Status: `available`, `assigned`, `reserved`, `dhcp`
- Range type and color overlaid on each IP from the ranges table
- Gateway IP auto-marked as `reserved` in virtual generation
- Scan results (responded, MAC) merged into IP view

## DNS Management

- Forward and reverse zone CRUD with enable/disable toggle
- SOA fields: primary NS, admin email, serial (auto-incrementing on any change), refresh, retry, expire, minimum TTL
- Record types: A, CNAME, MX, TXT, SRV, PTR with type-specific validation
- Per-record TTL
- CNAME conflict detection (no other records for same name)
- **Automatic PTR sync:** Creating/updating an A record in a forward zone auto-creates/updates the corresponding PTR in the matching reverse zone. Deleting an A record reverts the PTR to bare IP.
- Reverse zone auto-creation option when configuring a subnet
- Upstream DNS forwarder configuration (list of IPs)
- **DNSmasq integration:** Atomic config writes (write to tmp, rename). Hostsdir for A/PTR records (hot-reload). conf.d for CNAME/MX/TXT/SRV (requires SIGHUP). SIGHUP signaling after config changes.
- Manual "Apply DNS" button to force regenerate all configs

## DHCP Management

- DHCP scopes linked to ranges of type "DHCP Scope"
- Scope settings: lease time, enabled/disabled, description
- **DHCP Options system:**
  - Static catalog of standard DHCP options (code, name, label, type, dnsmasq option name). Types: `ip`, `ip-list`, `text`, `text-list`, `number`, `select`
  - Global option defaults table — values inherited by all scopes unless overridden
  - Per-scope option overrides table
  - Options include: Router (3), DNS Servers (6), Hostname (12), Domain Name (15), MTU (26), NTP Servers (42), WINS/NetBIOS (44, 46), Vendor Class (60), TFTP/PXE (66, 67, 150), Domain Search (119), Classless Static Routes (121), WPAD (252)
  - Option 3 (Router/Gateway) override display — shows custom gateway when set, falls back to subnet gateway
- MAC-based DHCP reservations with hostname and description
- Lease tracking synced from dnsmasq.leases file (fs.watchFile)
- Available ranges endpoint (DHCP Scope ranges without active scopes)
- **DNSmasq config generation:** `dhcp-range` directives with tags, `dhcp-option` with tag scoping, `dhcp-hostsfile` for reservations. Scope options merged: global defaults overridden by per-scope values.
- Manual "Apply DHCP" button

## Network Scanning

- ARP/ping-based network scanning per subnet (max /20 = 4096 IPs)
- Background execution, non-blocking
- Prevents concurrent scans on the same subnet
- Scan results: IP, MAC, responded (bool), conflict detection
- Per-subnet configurable scan interval (5m, 15m, 30m, 1h, 4h)
- **Scan enable inheritance:** global default → per-subnet override → per-IP override
- Automatic scan scheduler
- Scan history with completed/failed status and timing
- Results merged into IP address view as non-blocking warnings

## Pi-hole Import

- Probe a Pi-hole instance by URL to detect available data
- Parse Pi-hole TOML configuration and hosts/CNAME/DHCP files
- Import DNS records (A, CNAME), DHCP reservations, and upstream DNS settings
- URL scheme validation (http/https only) to prevent SSRF
- MAC address format validation on DHCP reservation import
- Available as setup wizard step 3 or standalone feature

## Domain Blocklists

- Blocklist source management with URL, format auto-detection (hosts / domains / adblock), and category (ads, malware, tracking, adult, other)
- Per-source auto-update scheduling with configurable intervals
- Preconfigured popular sources (Steven Black, OISD, Pete Lowe) as quick-add options
- Deduplication across sources
- Whitelist with domain-level overrides
- Paginated domain search with source attribution
- Manual refresh (all or specific source)
- Statistics: per-source counts, total entries, last update times
- DNSmasq integration: generates `address=/domain/` directives; optional block page redirect IP
- Error tracking per source

## GeoIP DNS Filtering

- Country-based DNS query filtering with blocklist or allowlist modes
- DB-IP Lite MMDB database with monthly auto-download
- UDP DNS proxy sitting between DNSmasq and upstream resolvers
- LRU-cached country lookups with fail-open design (if lookup fails, allow query)
- Per-country rules with enable/disable toggle
- Query statistics and cache info
- Configurable proxy port
- Auto-starts on server boot if enabled

## Backup & Restore

- Single tar.gz archive containing: SQLite DB, TLS certificates, DNSmasq configs
- Manual backup creation and download
- Scheduled backups (daily/weekly/monthly) with retention policy (count-based), automatic initial backup on schedule enable
- Upload-based restore with validation
- Backup listing with metadata (filename, size, timestamp)

## Versioning & Updates

- Version read from root `package.json` (e.g., `0.1.0`)
- Version displayed in header bar
- In-app update checker: polls GitHub releases API every 6 hours (can be disabled via `update_check_enabled` setting)
- Update badge in header bar when new version available
- **Native update script** (`cidrella-update` / `scripts/update.sh`): downloads release tarball, backs up current install, extracts, installs dependencies, updates systemd units if changed, restarts services
- **Release build script** (`scripts/build-release.sh`): builds client, stages files, creates tarball, optionally tags and publishes GitHub release

## System & Operations

- System health dashboard: CPU, memory, disk usage, service status (DNSmasq, Node.js)
- Real-time log viewer with SSE streaming and pause/resume (buffers events while paused)
- Audit log viewer: paginated, filterable by action type, entity type, user
- TLS certificate management: view current cert info (subject, issuer, expiry, self-signed detection), upload custom PEM cert+key, reset to self-signed
- Settings management: subnet name template, default gateway position, upstream DNS, backup schedule/retention, GeoIP config, default scan interval/enabled, interface config, DNS/DHCP enable, update check enable
- Subnet calculator tool (CIDR validation, split preview)

## API Design

REST API under `/api/` prefix. All mutating endpoints require authentication. Permission checks via middleware (`requirePerm`). Async handler wrapper for consistent error handling. Endpoints return JSON. Audit logging on all write operations.

Key patterns:
- Preview endpoints (e.g., `/divide/preview`, `/merge/preview`) that validate and show results without committing
- Force/confirm pattern for destructive operations on allocated subnets (return 409 with `requires_confirmation: true`)
- Atomic database transactions for multi-step operations (divide, merge, configure)
- Config regeneration after DNS/DHCP changes with atomic file writes and SIGHUP

## Data Persistence

All state under a configurable data directory (`DATA_DIR` env var — `/data` for Docker, `/var/lib/cidrella` for native):
- `cidrella.db` — SQLite database
- `certs/` — TLS certificates (server.crt, server.key)
- `dnsmasq/` — DNSmasq configuration and data files (conf.d, hosts.d, dhcp-hosts.d)
- `backups/` — Backup archives
- `blocklists/` — Cached blocklist files
- `geoip/` — MMDB country database

## Ports

- 8443/TCP — HTTPS web UI and API
- 8080/TCP — HTTP (redirects to HTTPS)
- 53/TCP+UDP — DNS (DNSmasq)
- 67/UDP — DHCP (DNSmasq)

## Key Architectural Principles

- **Single container, no external dependencies.** Everything runs in one Docker container with host networking. Also deployable natively with systemd.
- **Database-first.** SQLite with migrations for schema evolution. Transactions for consistency. WAL mode for concurrent reads.
- **Atomic config writes.** Write to tmp file, then rename. Prevents partial writes.
- **Fail-open.** GeoIP proxy continues if MMDB fails. Scans don't block operations. Warnings don't prevent assignments.
- **Config migration on topology changes.** When dividing or merging subnets, DHCP scopes, ranges, DNS zones, and gateway assignments are migrated or preserved intelligently.
- **Virtual IP generation.** IPs are not pre-populated in the database. They're generated on demand during pagination, merged with any persisted metadata.
- **Safe process management.** PID validation before signaling dnsmasq (verify process name via `ps`). Systemctl preferred with PID fallback for Docker.
