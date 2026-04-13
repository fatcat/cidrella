# CIDRella — Native Installation (Debian/Ubuntu)

Recommended for production deployments on bare metal or LXC containers.

## Prerequisites

- Debian or Ubuntu (or derivative)
- Root access

## Installation

### Method A: Clone and install

```bash
git clone https://github.com/fatcat/cidrella.git
cd cidrella
sudo bash scripts/install.sh
```

### Method B: Download and review first

```bash
curl -sSLO https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh
less install.sh        # review the script
sudo bash install.sh   # run it
```

### Method C: One-line install

> **Warning**: This pipes a script directly into a root shell. Review Method B above if you prefer to inspect first. Very strongly recommend using method A or B as they both provide an opportunity to review the install script and the source code of the project before running anything.

```bash
curl -sSL https://raw.githubusercontent.com/fatcat/cidrella/main/scripts/install.sh | sudo bash
```

### Install a specific version

```bash
sudo bash install.sh --version 0.1.0
```

### What the installer does

The installer is interactive and will:

- Install Node.js 22+ (via NodeSource) if not present
- Install system dependencies (dnsmasq, build-essential, nmap, arping, etc.)
- Detect and handle conflicts with systemd-resolved (port 53)
- Handle existing dnsmasq installations (replace config, include config, or skip)
- Create a `cidrella` system user and data directory at `/var/lib/cidrella`
- Download and extract the latest release to `/opt/cidrella`
- Install and start systemd services

## First Login

Check the logs for the generated admin password:

```bash
journalctl -u cidrella --no-pager | grep Password
```

Open `https://<your-server-ip>:8443` and log in. A setup wizard will guide you through initial configuration.

## Updating

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

Database migrations run automatically on startup.

CIDRella also checks for updates in the background and shows a notification badge in the header when a new version is available.

## Configuration

### Data Directory

All persistent state is stored under `/var/lib/cidrella/`:

| Path | Contents |
|------|----------|
| `/var/lib/cidrella/cidrella.db` | SQLite database |
| `/var/lib/cidrella/certs/` | TLS certificates |
| `/var/lib/cidrella/dnsmasq/` | DNSmasq configuration |
| `/var/lib/cidrella/backups/` | Backup archives |
| `/var/lib/cidrella/blocklists/` | Cached blocklist files |
| `/var/lib/cidrella/geoip/` | GeoIP database |

### TLS Certificates

A self-signed certificate is auto-generated on first run. To use your own:

```bash
cp cert.pem key.pem /var/lib/cidrella/certs/
sudo systemctl restart cidrella
```

### Timezone

```bash
sudo systemctl edit cidrella
```

Add:

```ini
[Service]
Environment=TZ=America/New_York
```

Then restart:

```bash
sudo systemctl restart cidrella
```

### Networking

CIDRella requires the following ports:

| Port | Protocol | Service |
|------|----------|---------|
| 53 | TCP/UDP | DNS |
| 67 | UDP | DHCP server |
| 8443 | TCP | Web UI (HTTPS) |
| 8080 | TCP | HTTP redirect |

Native installs bind directly to these ports.

## Administration

### Reset Admin Password

If you've forgotten the admin password — or need to rotate credentials for any user — run the CLI reset wrapper as root:

```bash
sudo cidrella-reset-password           # resets 'admin'
sudo cidrella-reset-password someuser  # resets 'someuser'
```

The wrapper prints a fresh random password once, sets `must_change_password=1`, writes an `audit_log` entry with `action=password_reset_cli`, and records who performed the reset in `users.password_reset_by` (e.g. `cli:root@cidrella-prod`). On next successful login the user sees a red warning banner on the Change Password page identifying the reset — so if the legitimate owner sees that banner and didn't do the reset, they know someone with root shell access to the host ran it and should investigate immediately.

**Security notes**:

- The wrapper is `/usr/local/bin/cidrella-reset-password`, mode `0700 root:root` — only root can execute it.
- The actual filesystem security comes from `/var/lib/cidrella/cidrella.db` being mode `600 cidrella:cidrella` on v0.4.8+ installs. Anyone with root or cidrella shell access can bypass the wrapper and manipulate the DB directly; this is not a bug, it's the correct security boundary. Host access is total access.
- Every reset is audited and visible on next login. **This is the primary defense against unauthorized resets** — they can't be silent.

**Legacy installs (pre-v0.4.8)**: the wrapper is installed starting in v0.4.8. If you're on an older version, you can still run the underlying script directly, but note that v0.4.7+ installs no longer have system `node` — use the bundled runtime:

```bash
# Pre-v0.4.8 on v0.4.7+:
sudo -u cidrella DATA_DIR=/var/lib/cidrella /usr/local/bin/cidrella-node /opt/cidrella/server/src/reset-password.js admin

# Pre-v0.4.7 (system node present):
sudo -u cidrella DATA_DIR=/var/lib/cidrella node /opt/cidrella/server/src/reset-password.js admin
```

The behavior is the same; you just skip the wrapper. Upgrade to v0.4.8+ to get the audit + banner features.

### Database Reset

Delete the database file and restart. A new admin account will be generated:

```bash
sudo systemctl stop cidrella
sudo rm /var/lib/cidrella/cidrella.db
sudo systemctl start cidrella
```

There is also a database reset button on the Settings > Backup and Restore page.

The following persist on disk:
- TLS certificates
- DNSmasq configuration (regenerated on startup)
- Backup archives
- Downloaded blocklist files

### View Logs

```bash
journalctl -u cidrella -f
journalctl -u cidrella-dnsmasq -f
```

### Service Management

```bash
# Check status
sudo systemctl status cidrella
sudo systemctl status cidrella-dnsmasq

# Restart
sudo systemctl restart cidrella
sudo systemctl restart cidrella-dnsmasq
```
