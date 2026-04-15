# CIDRella — Native Installation (Debian/Ubuntu)

Recommended for production deployments on bare metal or LXC containers.

## Prerequisites

- Debian or Ubuntu (or derivative) on `amd64` or `arm64`
- Root access (or sudo)
- Network access to github.com (release download + signature verification)

> **Note on `arm64`**: the installer and bundled runtime *should* work on arm64 (the release tarballs are built for it and the Node binary + native modules are compiled for both architectures), but arm64 is **not tested** — all development and release validation runs on `amd64`. If you hit arm64-specific issues, please open a GitHub issue with the output of `uname -a`, `dpkg --print-architecture`, and the install.sh log.

**You do not need to install any system packages yourself.** The installer calls `apt-get` and pulls everything CIDRella needs. It is listed here only so you know what will land on the host:

| Package | Why |
|---|---|
| `dnsmasq` | DNS + DHCP engine |
| `openssl` | Self-signed TLS cert generation |
| `minisign` | Release tarball signature verification |
| `curl` | Release + GeoIP database downloads |
| `rsync` | A/B slot extraction during updates |
| `arping` | Network scanner (IP conflict detection) |
| `dnsutils` | `dig` / `nslookup` for DNS forwarder health checks |
| `libcap2-bin` | `setcap` for `CAP_NET_RAW` / `CAP_NET_BIND_SERVICE` on the bundled Node binary |
| `sudo` | Allowlisted privilege escalation for the `cidrella` service user (limited to `arping` from v0.4.11 forward) |
| `polkitd` (or `policykit-1` on older releases) | **Required from v0.4.11.** Authorizes the unprivileged `cidrella` service user to start the templated update worker and reload dnsmasq via D-Bus. Without a running polkit daemon the in-app UI updater cannot spawn its worker and fails with "Access denied." See the note below. |
| `build-essential` | Retained for users who want to `npm rebuild` manually; not used by the default install |
| `python3`, `python3-setuptools` | Anomaly detection daemon runtime |
| `python3-sklearn`, `python3-numpy`, `python3-joblib` | Anomaly detection ML libraries |

Node.js is **not** a prerequisite — a Node 22.x runtime is bundled inside the release tarball and installed under `/opt/cidrella-<slot>/runtime/node/`. No system Node required.

### polkit (v0.4.11+)

CIDRella v0.4.11 replaced the previous `sudo systemd-run` path for the in-app updater and dnsmasq reload with a polkit-gated `systemctl` path. The change was made because the v0.4.8 systemd hardening on `cidrella.service` implicitly enabled `NoNewPrivileges=yes` (via `RestrictSUIDSGID=` and several `Protect*` directives), which blocks sudo's setuid escalation from inside the service and silently broke the previous path. The polkit D-Bus path does not depend on setuid, so it works under the hardening.

What the installer does:
- Installs `polkitd` (preferred on Debian 12+ and Ubuntu 24.04+) or falls back to `policykit-1` (Debian 11, Ubuntu 22.04 and earlier)
- Drops a narrow rule at `/etc/polkit-1/rules.d/49-cidrella.rules` authorizing `subject.user == "cidrella"` to `start cidrella-update@*.service` and to `reload`/`restart cidrella-dnsmasq.service` via D-Bus (no other actions, no other units)
- Probes `pkaction --version` to confirm the JS rules engine is present, and verifies the polkit daemon is active before completing the install

If any step fails, the installer aborts with a diagnostic message. A working polkit daemon is **not optional** on v0.4.11+ native installs — the in-app updater depends on it.

**If you upgraded *to* v0.4.11 via `cidrella-update` from v0.4.10 or earlier**, your host is missing the polkit package, rule file, and templated unit because v0.4.11's `update.sh` did not reconcile that state on upgrade (only fresh installs via `install.sh` did). Symptom: the UI update panel fails with "Access denied" on every install click, or your stuck update status says `systemctl start cidrella-update@... failed: Access denied`. Recovery (run as root on the host):

```bash
# 1. Install polkit
apt-get update
apt-get install -y polkitd      # Debian 12+ / Ubuntu 24.04+
# apt-get install -y policykit-1  # older releases, if polkitd is unavailable

# 2. Install the rule file (shipped inside the tarball)
install -m 0644 -o root -g root \
  /opt/cidrella/scripts/polkit/49-cidrella.rules \
  /etc/polkit-1/rules.d/49-cidrella.rules

# 3. Install the templated update worker unit (also missing on CLI upgrades)
install -m 0644 -o root -g root \
  /opt/cidrella/scripts/systemd/cidrella-update@.service \
  /etc/systemd/system/cidrella-update@.service
systemctl daemon-reload

# 4. Start polkit. On some LXC builds systemd hits a "status=217/USER" race
#    on the first start attempt because the polkitd user was just created
#    and the cache hasn't refreshed — a reset-failed + start clears it.
systemctl reset-failed polkit 2>/dev/null || true
systemctl start polkit

# 5. Clear any stuck update-status record left behind by a failed attempt
rm -f /var/lib/cidrella/update-status.json

# 6. Retry the update via the UI (or run `cidrella-update` as root).
```

v0.4.13 moves this reconciliation into `update.sh` so the problem self-heals on the next upgrade. Until then, the manual procedure above is the only path — or use `cidrella-update` from a root shell, which bypasses the polkit requirement entirely.

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
- Install and start systemd services (`cidrella`, `cidrella-dnsmasq`, `cidrella-anomaly`, and the templated `cidrella-update@.service` worker on v0.4.11+)
- Install the polkit rule at `/etc/polkit-1/rules.d/49-cidrella.rules` and ensure the polkit daemon is active (v0.4.11+)

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
