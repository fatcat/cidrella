# dnsmasq coupling inventory & backend-API blueprint

> Status: living design note. No behavior change. Purpose: map every place
> dnsmasq leaks into the codebase, define the **backend service API** these
> should sit behind, and record how that API maps onto Kea + PowerDNS, so a
> future migration is a *swap of adapters*, not a teardown.

## The target shape

CIDRella's SQLite DB is the **canonical desired state**. Everything dnsmasq-side
is a *projection* of it. The plan is to introduce an internal **backend API**
whose resource model mirrors the (subset of) Kea + PowerDNS REST APIs we actually
use, with selectable adapters:

```
app/services  ──►  Backend API (intent, resource model)  ──►  adapter
                                                               ├── dnsmasq  (now: config-gen + file/log parse + reload)
                                                               ├── kea + powerdns (later: REST calls)
                                                               └── (selected by a `dns_backend` / `dhcp_backend` setting)
```

Mirror only the subset we use; don't reproduce the full vendor APIs. Where the
dnsmasq adapter can't satisfy an operation (DoT/DoH upstream, RPZ, DHCP hooks),
it returns "unsupported" / approximates, and that gap list is the migration map.

### Backend split (target)
| Concern | dnsmasq today | Future owner |
|---|---|---|
| DHCP (subnets, pools, DHCP Reservations, leases) | dnsmasq DHCP | **Kea** (Control Agent REST) |
| Local DNS zones/records (A/CNAME/MX/TXT/SRV/PTR, SOA) | dnsmasq host/conf files | **PowerDNS Authoritative** (REST zones/rrsets) |
| Recursion / forwarding / filtering / DNSSEC-validate / DoT-DoH | custom proxy + dnsmasq | **PowerDNS Recursor** (forward-zones, RPZ, Lua, native DoT/DoH) |

## The coupling points (the ~7 seams)

| # | Seam | Where (file) | dnsmasq mechanism | Intent-named API op (proposed) | Kea/PowerDNS equivalent | Adapter gap |
|---|---|---|---|---|---|---|
| 1 | **DNS records/zones config** | `utils/dnsmasq.js` (`regenerateHostsDir`, `regenerateConfDir`, `regenerateDnsmasqConf`) | render `hosts.d/*.hosts` + `conf.d/zone-*.conf`, reload | `applyZones()` / `upsertRecord()` / `deleteRecord()` | PowerDNS Auth `PATCH /zones/:zone` (rrsets) | full file regen vs targeted rrset PATCH |
| 2 | **DHCP Scope/DHCP Reservation config** | `utils/dhcp.js` (`regenerateDhcpConfigs`, `generateScopeConfig`), `dhcp-hosts.d` | render `dhcp-range=`, `dhcp-host=`, options; reload | `applyDhcpScopes()` / `upsertReservation()` | Kea `subnet4`/`reservation` via `config-set`/`reservation-add` | per-scope option mapping; no API push |
| 3 | **Lease ingestion** | `utils/dhcp.js` (`syncLeases`, `startLeaseWatcher`, `LEASE_FILE`), `models/dhcp-lease.js` | poll `dnsmasq.leases` file | `getLeases()` (+ change events) | Kea `lease4-get-all` / memfile/DB backend | file-poll vs API/DB; 10s latency |
| 4 | **DHCP fingerprint capture** | `utils/dhcp-fingerprint.js` | parse `log-dhcp` text (opt55/60/hostname) | `getDhcpFingerprintEvents()` | Kea hooks (`flex-id`, lease cmds, packet callouts) | log-parse vs structured hook data |
| 5 | **Recursion + filtering proxy** | `utils/dns-proxy.js` (blocklist, GeoIP, DNSSEC TCP relay, EDNS, bypass) | bespoke UDP/TCP proxy in front of dnsmasq | `setBlocklist()` / `setGeoPolicy()` / forward config | Recursor **RPZ** (blocklist), **Lua** (GeoIP), native validation | entire hand-rolled proxy → Recursor features |
| 6 | **DNSSEC** | `utils/dnsmasq.js` (`dnssec*` directives, `dnsmasqSupportsDnssec`) | inject `dnssec`/`trust-anchor` directives | `setDnssec(enabled)` | Recursor `dnssec=validate` (+ Auth signing) | no online signing; validate-only |
| 7 | **Forwarders / upstreams** | `utils/dnsmasq.js` (`server=` lines), settings `dns_upstream_servers` | `server=` IPs (plain UDP/TCP only) | `setForwarders([{addr, mode, hostname}])` | Recursor `forward-zones` + DoT/DoH upstream | **no DoT/DoH** → needs the in-Node stub (see below) |

### Supporting coupling
- **Process control**: `utils/dnsmasq.js` `signalDnsmasq()` / `restartDnsmasq()` + `scripts/systemd/cidrella-dnsmasq.service` + s6 `run`. Future: adapter calls REST, no SIGHUP/restart. Behind `reload()` / implicit (API is live).
- **Apply orchestration**: `utils/after-commit.js` hooks (`regenerate_dns`, `regenerate_dhcp`, `regenerate_dnsmasq_conf`). This is *already* the intent layer. Callers register "make DNS reflect the DB," not "write file X." Keep funnelling everything through here. It's where the backend API will hang.
- **DHCP→DNS derivation / PTR sync**: `utils/ip-sync.js`, `services/subnet-dns-topology.js`. Today leans on dnsmasq doing some of this internally; split backends need explicit DDNS (Kea DDNS → PowerDNS) or app-mediated sync. **Highest-risk seam** for a split-backend world.

## Guardrails for new features (so coupling doesn't grow)
1. **DB stays canonical.** No dnsmasq-flavored strings in the schema; store intent (records, scopes, modes), render at the edge.
2. **One module per seam.** Any new dnsmasq touch goes behind an intent-named function in the owning module (above), never inline in routes/services.
3. **Route everything through `after-commit` hooks**, not direct `dnsmasq.js` calls from features.
4. **Build new features adapter-swappable.** E.g. encrypted forwarders = a self-contained in-Node DoT/DoH stub that dnsmasq points `server=` at. When Recursor lands, delete the stub and point `setForwarders()` at Recursor's native DoT/DoH. (Seam #7.)

## Migration approach (when serious, not now)
1. **Spike PowerDNS Recursor + RPZ** against the blocklist/GeoIP needs to validate it can retire `dns-proxy.js`. Let the real second implementation define the API boundary (don't finalize the interface from dnsmasq alone).
2. Introduce the backend API as a thin facade over today's dnsmasq code (adapter = current functions, renamed to intent ops). No behavior change.
3. Add the PowerDNS/Kea adapter; flip `dns_backend`/`dhcp_backend` per deployment; deprecate dnsmasq over one release (no permanent dual stack).
