# CIDRella: Docker Installation

## Prerequisites

- Docker and Docker Compose
- Linux host networking support. Docker Desktop on macOS/Windows is not a
  good fit for DHCP service because the container is behind a VM and does not
  share the physical LAN's L2 broadcast domain.
- Administrative control of the host firewall. DHCP and DNS packets are still
  subject to host `nftables`/`iptables` policy when the container uses host
  networking.

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

The included `docker-compose.yml` uses `network_mode: host`. This is
intentional: DHCP discovery and offer traffic uses L2 broadcast, and Docker
bridge port publishing does not reliably carry that traffic. Do not replace
host networking with `ports:` mappings if CIDRella will serve DHCP.

The compose file also grants:

| Capability | Why it is needed |
|------------|------------------|
| `NET_ADMIN` | Allows dnsmasq/network operations commonly required by DHCP service in containers. |
| `NET_RAW` | Allows ARP and ICMP liveness probes. |
| `NET_BIND_SERVICE` | Allows binding DNS/DHCP/web listeners on privileged ports when configured. |

### DHCP Reachability

CIDRella can hand out DHCP leases only on networks where the Docker host has
direct L2 access, or where a router forwards DHCP to it with a relay/IP-helper.
If clients are on another VLAN or subnet and there is no DHCP relay, they will
not see CIDRella's DHCP replies no matter how Docker is configured.

For multi-interface hosts:

1. Start the container with host networking.
2. Open CIDRella and go to Settings > Interfaces.
3. Enable DHCP only on the intended interface/address.
4. Confirm the created DHCP scopes match the subnet on that interface.

If another DHCP server is already active on the same broadcast domain, clients
may receive leases from either server. Disable the old DHCP server or isolate
CIDRella testing to a lab VLAN.

### Host Firewall and nftables

Because host networking is used, Docker does not create the usual DNAT rules
for CIDRella. The host firewall must allow inbound traffic directly to the
host:

```bash
# nftables examples; adapt interface name and policy style to your host
sudo nft add rule inet filter input udp dport 67 accept
sudo nft add rule inet filter input udp dport 53 accept
sudo nft add rule inet filter input tcp dport 53 accept
sudo nft add rule inet filter input tcp dport 8443 accept
sudo nft add rule inet filter input tcp dport 8080 accept
```

If your host uses firewalld or ufw, use those tools instead of inserting raw
nftables rules:

```bash
# ufw example
sudo ufw allow 67/udp
sudo ufw allow 53
sudo ufw allow 8443/tcp
sudo ufw allow 8080/tcp
```

DHCP replies may also be affected by distribution-specific bridge, container,
or anti-spoofing rules. When troubleshooting, first test from a client on the
same physical/VLAN segment as the Docker host.

### Network Driver Alternatives

Host networking is the recommended Docker mode.

`macvlan` or `ipvlan` can work for advanced deployments where the container
needs its own address on the LAN, but they are easier to misconfigure:

- The parent switch port must allow the extra MAC/IP behavior.
- The Docker host often cannot talk to its own macvlan container without an
  additional host-side macvlan interface.
- DHCP broadcast behavior still depends on the parent interface and VLAN.

Use macvlan/ipvlan only if you already operate those Docker network types.

### Quick Network Checks

Check that CIDRella is listening:

```bash
docker compose exec cidrella ss -lntup | grep -E ':(53|67|8443|8080)\b'
```

Check whether DHCP packets are reaching the host:

```bash
sudo tcpdump -ni <interface> 'udp port 67 or udp port 68'
```

Check DNS from another LAN host:

```bash
dig @<cidrella-host-ip> example.com
```

Check active liveness probe permissions inside the container:

```bash
docker compose exec --user cidrella cidrella /usr/sbin/arping -c 1 -w 2 -I <interface> <lan-ip>
docker compose exec --user cidrella cidrella ping -c 1 <lan-ip>
```

If `arping` or `ping` reports missing `CAP_NET_RAW`, confirm the container was
started from the current compose file and that your container runtime has not
dropped `NET_RAW`.

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

The reset generates a random password (printed once to stdout), sets `must_change_password=1`, writes an `audit_log` entry, and (on v0.4.8+) populates `users.password_reset_by` with the actor label (`cli:<os-user>@<container-hostname>`). On the next successful login, the legitimate account owner sees a red warning banner on the Change Password page identifying who performed the reset. If they didn't do it, they know a host-level actor did and should investigate.

**Docker-specific notes**:

- The native-install wrapper at `/usr/local/bin/cidrella-reset-password` is **not** present in the Docker image. It's installed only by `scripts/install.sh`, which Docker images don't run. The direct `node` invocation above is the Docker-native equivalent.
- The Docker image uses the base `node:24-alpine` Node runtime, not the bundled runtime that native installs get from v0.4.7+ onward. That's intentional: in Docker, container image updates already handle the runtime versioning.
- The audit trail and Change Password banner work the same way in Docker as in native installs. The logic is in `reset-password.js` itself, not in the native wrapper.
- There's no equivalent to the v0.4.8 file permission tightening (`600 cidrella:cidrella` on `cidrella.db`, etc.) inside the Docker image. The container's isolation is your security boundary. If an attacker has `docker exec` access, the permissions inside the container are moot anyway.

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
