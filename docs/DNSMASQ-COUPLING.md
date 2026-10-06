# dnsmasq coupling and the backend layer

> Status: living design note. As of 0.5.1 every dnsmasq call goes through the backend layer in
> `server/src/backends/`, with dnsmasq as its only adapter. This page maps where dnsmasq still
> leaks past that layer, what the layer's API is, and how it maps onto Kea and PowerDNS, so the
> migration is a swap of adapters rather than a teardown.

## The target shape

CIDRella's SQLite DB is the **canonical desired state**. Everything a backend holds is a
projection of it. The backend API's resource model mirrors the subset of the Kea and PowerDNS
REST APIs we actually use, with selectable adapters:

```
routes, services  ──►  services/backend-apply.js  ──►  backends/index.js  ──►  adapter
  (after-commit hooks,     (applyDns, applyDhcp,        (registry: which         ├── dnsmasq (0.5.1: config files + log parse + SIGHUP/restart)
   boot, lease sync)        applyResolver, boot)         adapter fills a role)   └── kea, powerdns (later: REST calls)
```

Mirror only the subset we use; don't reproduce the full vendor APIs. Where an adapter can't do
an operation (DoT/DoH upstream in dnsmasq, RPZ, DHCP hooks) it says so in `capabilities()`, and
that gap list is the migration map.

### Backend split (target)

| Concern                                                        | dnsmasq today           | Future owner                                                    |
| -------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| DHCP (subnets, pools, DHCP Reservations, leases)               | dnsmasq DHCP            | **Kea** (Control Agent REST)                                    |
| Local DNS zones/records (A/CNAME/MX/TXT/SRV/PTR, SOA)          | dnsmasq host/conf files | **PowerDNS Authoritative** (REST zones/rrsets)                  |
| Recursion / forwarding / filtering / DNSSEC-validate / DoT-DoH | custom proxy + dnsmasq  | **PowerDNS Recursor** (forward-zones, RPZ, Lua, native DoT/DoH) |

## The backend layer (0.5.1)

```
server/src/backends/
  contract.js   the op lists, typedefs, assertBackendShape, roleStatuses
  index.js      registry: getService(role), getDnsBackend, getDhcpBackend, getRaBackend,
                uniqueServices, backendStatuses. Always dnsmasq for now; no setting yet.
  dnsmasq/      the adapter: index.js (createDnsmasqBackend) plus the code that used to
                live in utils/ (dnsmasq.js, dhcp.js, lease-file.js, lease-release.js,
                dhcp-log-parser.js, log-format.js, legacy.js, paths.js)
server/src/services/
  backend-apply.js    what the after-commit hooks run, and the boot and listen paths
  dhcp-lease-sync.js  backend-neutral lease ingestion and the single-flight watcher loop
```

The contract (`backends/contract.js` has the full typedefs):

- **Apply ops are desired state.** Each reads the database and makes the backend match it,
  returning `{changed, activation: 'none'|'reload'|'restart', activated}`. A second call with
  nothing changed reports `changed: false`. Adapters never write the database.
- **Roles:** `dns` (applyZones, applyResolver, applyListen, onClockSynchronized, optional
  retireLegacyArtifacts), `dhcp` (applyScopes, readLeases, watchLeases, releaseLease,
  serverIdentity) and `ra` (a slot; dnsmasq sends Router Advertisements from its DHCPv6 scope
  files, so `applyScopes` covers them).
- **Service ops** run once per daemon, however many roles it fills: status, capabilities,
  transaction (validated as one, so boot runs a single `dnsmasq --test`), applyActivation,
  activate, restart, prepare and logSource.
- **Orchestration stays neutral.** `applyDhcp` renders scopes, runs `syncDhcpDnsRecords` from
  the lease table, then activates, the same order as before the facade. The three hook names
  (`regenerate_dns`, `regenerate_dhcp`, `regenerate_dnsmasq_conf`) are kept because migration
  065 CHECKs them; `after-commit.js` takes their handlers from `registerHookHandlers` at boot.

What enforces it:

- ESLint `no-restricted-imports`: only `server/src/backends/**` imports `backends/dnsmasq/**`.
- `scripts/check-backend-imports.js` (in `npm run lint`) catches what ESLint can't see:
  `import()` calls and `vi.mock` path strings in tests.
- `scripts/check-db-ownership.js` refuses SQL writes under `backends/`.
- `tests/contract/backend-contract.js` runs the same contract against the dnsmasq adapter and
  the in-memory fake (`tests/helpers/fake-backends.js`).
- `tests/integration/backends/dnsmasq-golden.test.js` snapshots every generated file and the
  command sequence for every entry point; the 0.5.1 refactor left them byte-identical.

## The seams

| #   | Seam                                | Backend op                                                              | dnsmasq adapter today                                                                                                                                                                                 | Kea/PowerDNS equivalent                                          | Adapter gap                                                                                 |
| --- | ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | **DNS records/zones**               | `dns.applyZones`                                                        | `backends/dnsmasq/dnsmasq.js` renders `hosts.d/records.hosts` (A/AAAA, each address's canonical PTR name first) and `conf.d/zone-*.conf` (CNAME/MX/TXT/SRV, PTRs the hosts file can't answer); SIGHUP | PowerDNS Auth `PATCH /zones/:zone` (rrsets)                      | full file regen vs targeted rrset PATCH                                                     |
| 2   | **DHCP scopes and reservations**    | `dhcp.applyScopes`                                                      | `backends/dnsmasq/dhcp.js` renders `dhcp-range=`, `dhcp-host=`, options; restart or SIGHUP                                                                                                            | Kea `subnet4`/`reservation` via `config-set`/`reservation-add`   | per-scope option mapping (`dnsmasqName`, REVIEW DNSMASQ-06); lease time syntax (DNSMASQ-07) |
| 3   | **Lease ingestion**                 | `dhcp.readLeases`, `dhcp.watchLeases`                                   | `backends/dnsmasq/lease-file.js` reads `dnsmasq.leases` once it settles; `fs.watchFile`                                                                                                               | Kea `lease4-get-all` / `lease6-get-all`, or its lease DB         | file poll vs API; `services/dhcp-lease-sync.js` is already neutral                          |
| 4   | **Lease release**                   | `dhcp.releaseLease`                                                     | `backends/dnsmasq/lease-release.js` (`dhcp_release`/`dhcp_release6`)                                                                                                                                  | Kea `lease4-del` / `lease6-del`                                  | none expected                                                                               |
| 5   | **DHCP fingerprint capture**        | `logSource().createDhcpParser`                                          | `backends/dnsmasq/dhcp-log-parser.js` parses `log-dhcp` text (opt55/60/hostname)                                                                                                                      | Kea hooks (packet callouts, lease cmds)                          | log parse vs structured hook data                                                           |
| 6   | **Query log readers**               | `logSource()` (`path`, `querySourceIp`, `dhcpDirection`, `isDhcpLine`)  | `backends/dnsmasq/log-format.js` regexes, read by passive liveness, the metrics aggregator and the log viewer                                                                                         | PowerDNS Recursor protobuf / dnstap; Kea logs                    | a null `logSource()` turns those readers off; they need a structured feed instead           |
| 7   | **Recursion + filtering proxy**     | none (stays in `utils/dns-proxy.js`)                                    | bespoke UDP/TCP proxy in front of dnsmasq (blocklist, GeoIP, DNSSEC TCP relay, EDNS, bypass)                                                                                                          | Recursor **RPZ** (blocklist), **Lua** (GeoIP), native validation | the whole proxy becomes Recursor features                                                   |
| 8   | **DNSSEC**                          | `dns.applyResolver`, `capabilities().dnssec`, `dns.onClockSynchronized` | `dnssec`/`trust-anchor` directives, `dnssec-no-timecheck` until NTP sync, then SIGHUP                                                                                                                 | Recursor `dnssec=validate` (+ Auth signing)                      | validate only, no online signing                                                            |
| 9   | **Forwarders / upstreams**          | `dns.applyResolver`                                                     | `server=` lines (plain UDP/TCP), pointed at the in-Node DoT/DoH stub on 127.0.0.1:5356 when encryption is on                                                                                          | Recursor `forward-zones` + native DoT/DoH upstream               | dnsmasq has no DoT/DoH (`encryptedUpstream: false`)                                         |
| 10  | **Listen addresses and interfaces** | `dns.applyListen`, `activate`                                           | `interface=`/`listen-address=`/`no-dhcp-interface=` in `dnsmasq.conf`; restart                                                                                                                        | PowerDNS `local-address`; Kea `interfaces-config`                | one daemon today, two to configure after the split                                          |
| 11  | **Process control and health**      | `status`, `activate`, `restart`, `applyActivation`, `prepare`           | systemd `cidrella-dnsmasq` unit (s6 in Docker); health and restart ask systemd, `pidof` only without systemctl                                                                                                               | REST is live; health is the API answering                        | no SIGHUP/restart once the adapter is REST                                                  |

**DHCP to DNS derivation and PTR sync** (`utils/ip-sync.js`, `services/subnet-dns-topology.js`,
`syncDhcpDnsRecords`) is app-mediated and neutral. It stays the **highest-risk seam** for a
split-backend world: Kea DDNS into PowerDNS or keeping the app in the loop has to be decided
before Kea lands.

## What still knows about dnsmasq outside the layer

Deliberate, each with a reason:

- `utils/dns-proxy.js` and `utils/encrypted-forwarder.js`: the proxy forwards to dnsmasq's
  internal port (`resolveDnsmasqInternalPort` in `config/defaults.js`). They go when the
  Recursor replaces them (seam 7).
- `DATA_DIR/dnsmasq`: backups carry it, and the paths are defined once in
  `backends/dnsmasq/paths.js`.
- Ops files: `scripts/systemd/cidrella-dnsmasq.service`, polkit rules, the s6 service, the
  Dockerfile, `install.sh` and `update.sh`. A Kea or PowerDNS release ships its own units.
- API fields kept for one release: `services.dnsmasq` on `/api/health/system` and the top-level
  `dnsmasq` on `/api/metrics/services` (both replaced by `backends`, removed in 0.5.2), and
  `dnsmasq` in the `/api/interfaces` save response.
- `dnsmasqName` in the DHCP option catalog (REVIEW DNSMASQ-06) and the stored `lease_time`
  syntax (DNSMASQ-07).
- Router Advertisements are rendered inside the DHCPv6 scope files, so the `ra` role cannot
  move to another daemon until that render is split out.

## Guardrails for new features

1. **DB stays canonical.** No backend-flavored strings in the schema; store intent (records,
   scopes, modes) and render in the adapter.
2. **Go through the layer.** A feature that changes what DNS or DHCP serve queues an after-commit
   hook or calls `services/backend-apply.js`; a feature that needs backend facts asks
   `backends/index.js`. The lint guards refuse anything else.
3. **Ask capabilities, don't assume dnsmasq.** A feature that only some backends can do checks
   `capabilities()` and says why it is off.
4. **Build new features adapter-swappable.** E.g. encrypted forwarders are a self-contained
   in-Node DoT/DoH stub that dnsmasq points `server=` at. When Recursor lands, delete the stub
   and point the forwarders at Recursor's native DoT/DoH.

## Migration approach

1. **Spike PowerDNS Recursor + RPZ** against the blocklist and GeoIP needs to confirm it can
   retire `dns-proxy.js`. Let the real second implementation correct the API boundary rather
   than finalizing it from dnsmasq alone.
2. ~~Introduce the backend API as a thin facade over today's dnsmasq code.~~ Done in 0.5.1.
3. **Kea first** (DHCP role): a `backends/kea/` adapter, a `dhcp_backend` setting read by the
   registry, the fixes for DNSMASQ-06 and DNSMASQ-07, and the DDNS decision above. The contract
   test runs against it unchanged.
4. **PowerDNS** (DNS role) after that; deprecate dnsmasq over one release, no permanent dual
   stack.
