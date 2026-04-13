# CIDRella — Docker Installation

## Prerequisites

- Docker and Docker Compose
- Host networking support (required for DHCP broadcast)

## Installation

```bash
git clone https://github.com/fatcat/cidrella.git
cd cidrella
docker compose up -d --build
```

## First Login

Check the logs for the generated admin password:

```bash
docker compose logs cidrella | grep Password
```

Open `https://<your-server-ip>:8443` and log in. A setup wizard will guide you through initial configuration.

## Updating

```bash
cd cidrella
git pull
docker compose up -d --build
```

Database migrations run automatically on startup.

## Configuration

### Data Directory

All persistent state is stored in the `./data/` volume mount:

| Path | Contents |
|------|----------|
| `data/cidrella.db` | SQLite database |
| `data/certs/` | TLS certificates |
| `data/dnsmasq/` | DNSmasq configuration |
| `data/backups/` | Backup archives |
| `data/blocklists/` | Cached blocklist files |
| `data/geoip/` | GeoIP database |

### TLS Certificates

A self-signed certificate is auto-generated on first run. To use your own:

```bash
cp cert.pem key.pem data/certs/
docker compose restart
```

### User/Group Ownership

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

Set the `TZ` environment variable:

```bash
TZ=America/New_York docker compose up -d
```

Or add to `.env`:

```
TZ=America/New_York
```

### Networking

CIDRella requires the following ports:

| Port | Protocol | Service |
|------|----------|---------|
| 53 | TCP/UDP | DNS |
| 67 | UDP | DHCP server |
| 8443 | TCP | Web UI (HTTPS) |
| 8080 | TCP | HTTP redirect |

Docker runs with `network_mode: host` for DHCP broadcast support.

## Administration

### Reset Admin Password

Run the reset script inside the container **as the cidrella user** so the updated database file stays owned by `cidrella:cidrella` and doesn't get chowned to root by accident:

```bash
docker compose exec --user cidrella -e DATA_DIR=/data cidrella \
  node /app/server/src/reset-password.js
```

To reset a specific user:

```bash
docker compose exec --user cidrella -e DATA_DIR=/data cidrella \
  node /app/server/src/reset-password.js someuser
```

The reset generates a random password (printed once to stdout), sets `must_change_password=1`, writes an `audit_log` entry, and — on v0.4.8+ — populates `users.password_reset_by` with the actor label (`cli:<os-user>@<container-hostname>`). On the next successful login, the legitimate account owner sees a red warning banner on the Change Password page identifying who performed the reset. If they didn't do it, they know a host-level actor did and should investigate.

**Docker-specific notes**:

- The native-install wrapper at `/usr/local/bin/cidrella-reset-password` is **not** present in the Docker image. It's installed only by `scripts/install.sh`, which Docker images don't run. The direct `node` invocation above is the Docker-native equivalent.
- The Docker image uses the base `node:22-alpine` Node runtime, not the bundled runtime that native installs get from v0.4.7+ onward. That's intentional — in Docker, container image updates already handle the runtime versioning.
- The audit trail and Change Password banner work the same way in Docker as in native installs — the logic is in `reset-password.js` itself, not in the native wrapper.
- There's no equivalent to the v0.4.8 file permission tightening (`600 cidrella:cidrella` on `cidrella.db`, etc.) inside the Docker image. The container's isolation is your security boundary — if an attacker has `docker exec` access, the permissions inside the container are moot anyway.

### Database Reset

```bash
docker compose run --rm reset
docker compose restart cidrella
```

There is also a database reset button on the Settings > Backup and Restore page.

This deletes the SQLite database and reinitializes on next startup. A new admin account will be generated. The following persist on disk:
- TLS certificates
- DNSmasq configuration (regenerated on startup)
- Backup archives
- Downloaded blocklist files

### View Logs

```bash
docker compose logs cidrella -f
```

### Restart Services

```bash
docker compose restart cidrella
```
