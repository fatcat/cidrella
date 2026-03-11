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

```bash
docker compose exec -e DATA_DIR=/data cidrella node /app/server/src/reset-password.js
```

To reset a specific user:

```bash
docker compose exec -e DATA_DIR=/data cidrella node /app/server/src/reset-password.js <username>
```

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
