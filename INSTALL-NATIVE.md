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

> **Warning**: This pipes a script directly into a root shell. Review Method B above if you prefer to inspect first.

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

```bash
cd /opt/cidrella
sudo -u cidrella DATA_DIR=/var/lib/cidrella node server/src/reset-password.js
```

To reset a specific user:

```bash
sudo -u cidrella DATA_DIR=/var/lib/cidrella node server/src/reset-password.js <username>
```

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
