# dnsmasq coupling and the backend layer

> Status: living design note. As of 0.5.1 every dnsmasq call goes through the backend layer in
> `server/src/backends/`. 0.5.2 adds the second adapter, Kea, for the DHCP role (`backends/kea/`,
> see "Kea" below). This page maps where dnsmasq still
> leaks past that layer, what the layer's API is, and how it maps onto Kea and PowerDNS, so the
> migration is a swap of adapters rather than a teardown.

## The target shape

CIDRella's SQLite DB is the **canonical desired state**. Everything a backend holds is a
projection of it, through selectable adapters:

```
routes, services  ──►  services/backend-apply.js  ──►  backends/index.js  ──►  adapter
  (after-commit hooks,     (applyDns, applyDhcp,        (registry: which         ├── dnsmasq (0.5.1: config files + log parse + SIGHUP/restart)
   boot, lease sync)        applyResolver, boot)         adapter fills a role)   └── kea, powerdns (later: REST calls)
```

The contract is a **capability-gated superset**, not the dnsmasq subset (decided 2026-10-07).
`backends/features.js` lists every backend-dependent feature CIDRella chooses to offer, from a
survey of dnsmasq, Kea and PowerDNS with the maintainer's verdict on each. Every adapter
answers `capabilities()` as `{ featureId: boolean }` for the roles it fills, so a feature only
Kea or PowerDNS can do (zone transfers, a DHCP audit log) is offered when that backend is
active and refused when it is not. Routes refuse an unsupported feature with
`refuseUnlessSupported` (409, `BACKEND_FEATURE_UNSUPPORTED`); the client asks
`useFeatures().supports(id)` and shows `reason(id)`. A feature turns true for an adapter when
CIDRella renders it through that adapter, not when the daemon merely has the directive.

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
- **Roles:** `dns` (applyZones, applyResolver, applyListen, onClockSynchronized, servedTtl,
  optional retireLegacyArtifacts), `dhcp` (applyScopes, readLeases, watchLeases, releaseLease,
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
| 1   | **DNS records/zones**               | `dns.applyZones`                                                        | `backends/dnsmasq/dnsmasq.js` renders `hosts.d/records.hosts` (A/AAAA, each address's canonical PTR name first) and `conf.d/zone-*.conf` (CNAME/MX/TXT/SRV, PTRs the hosts file can't answer); SIGHUP | PowerDNS Auth `PATCH /zones/:zone` (rrsets)                      | full file regen vs targeted rrset PATCH; one TTL (`local-ttl=60`) for every record but a CNAME, so `servedTtl` reports that, not the stored TTL |
| 2   | **DHCP scopes and reservations**    | `dhcp.applyScopes`                                                      | `backends/dnsmasq/dhcp.js` renders `dhcp-range=`, `dhcp-host=`, options; restart or SIGHUP                                                                                                            | Kea (0.5.2): `kea-dhcp{4,6}.conf` rendered from the same scope model (`backends/shared/dhcp-scope-model.js`), checked with `kea-dhcp4 -t`, reloaded with SIGHUP | dnsmasq sends DHCPv4 numbers at the wrong width (DNSMASQ-08) |
| 3   | **Lease ingestion**                 | `dhcp.readLeases`, `dhcp.watchLeases`                                   | `backends/dnsmasq/lease-file.js` reads `dnsmasq.leases` once it settles; `fs.watchFile`                                                                                                               | Kea (0.5.2): `lease4/6-get-page`; `watchLeases` polls the lease statistics | a page scan is not atomic, so a scan during which Kea handed out an address reads as unsettled |
| 4   | **Lease release**                   | `dhcp.releaseLease`                                                     | `backends/dnsmasq/lease-release.js` (`dhcp_release`/`dhcp_release6`)                                                                                                                                  | Kea (0.5.2): `lease4-del` / `lease6-del`                         | none                                                                                        |
| 5   | **DHCP fingerprint capture**        | `logSource().createDhcpParser`                                          | `backends/dnsmasq/dhcp-log-parser.js` parses `log-dhcp` text (opt55/60/hostname)                                                                                                                      | Kea (0.5.2): the `legal_log` hook, formatted to one line per committed lease (`backends/kea/legal-log-parser.js`) | Kea logs committed leases only, so DHCP message counts come from `dhcpCounters()` instead |
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
- `no-hosts` and `local-ttl` are managed in `dnsmasq.conf`, not `conf.d/`, because the
  installer's include mode points a host's own dnsmasq at `conf.d/`.
- Router Advertisements are rendered inside the DHCPv6 scope files, so the `ra` role cannot
  move to another daemon until that render is split out.

## Guardrails for new features

1. **DB stays canonical.** No backend-flavored strings in the schema; store intent (records,
   scopes, modes) and render in the adapter. What every DHCP adapter renders from is
   `backends/shared/dhcp-scope-model.js`; an adapter decides syntax, never which option a scope
   gets.
2. **Go through the layer.** A feature that changes what DNS or DHCP serve queues an after-commit
   hook or calls `services/backend-apply.js`; a feature that needs backend facts asks
   `backends/index.js`. The lint guards refuse anything else.
3. **Ask for the feature, don't assume dnsmasq.** A feature that only some backends can do has a
   `backends/features.js` id; the server asks `supports(id)` (or `refuseUnlessSupported` in a
   route) and the client `useFeatures().supports(id)`, which says why it is off.
4. **Build new features adapter-swappable.** E.g. encrypted forwarders are a self-contained
   in-Node DoT/DoH stub that dnsmasq points `server=` at. When Recursor lands, delete the stub
   and point the forwarders at Recursor's native DoT/DoH.

## Migration approach

1. **Spike PowerDNS Recursor + RPZ** against the blocklist and GeoIP needs to confirm it can
   retire `dns-proxy.js`. Let the real second implementation correct the API boundary rather
   than finalizing it from dnsmasq alone.
2. ~~Introduce the backend API as a thin facade over today's dnsmasq code.~~ Done in 0.5.1.
3. **Kea first** (DHCP role, 0.5.2): the adapter is in `backends/kea/` and passes the contract
   test. DNSMASQ-06 and -07 are fixed, and DDNS stays with CIDRella (no Kea D2). Still to come:
   the `dhcp_backend` setting and the switch with its lease handover, and the packaging.
4. **PowerDNS** (DNS role) after that; deprecate dnsmasq over one release, no permanent dual
   stack.

## Kea (0.5.2)

`backends/kea/` fills the DHCP role with ISC Kea 3.0, one daemon per family. dnsmasq keeps DNS
and the Router Advertisements. The configuration is file-canonical like dnsmasq's: `applyScopes`
renders `DATA_DIR/kea/kea-dhcp4.conf` and `kea-dhcp6.conf`, `kea-dhcp4 -t` checks them inside
the shared validated-file transaction (`backends/shared/validated-files.js`), and a SIGHUP
(`systemctl reload`) makes Kea reread them. Leases stay in Kea's memfile and move through the
HTTP control API (`lease_cmds`, `stat_cmds`), with basic auth on 127.0.0.1 and a generated
password under `DATA_DIR/kea/secret`.

How CIDRella's model maps onto Kea (`backends/kea/render.js`):

- A Kea subnet id is the `subnets.id`. Several scopes on one network are one Kea subnet; the
  first scope's options and lease time are the subnet's, another scope's options ride on its
  own pools.
- Reservations are in the configuration file, not `host_cmds`, so the file is the whole
  desired state. DDNS is off; Kea still stores the name a client sends.
- Catalog options are written as text Kea parses by its own definitions. Where the text a user
  enters for dnsmasq is not what Kea parses, `KEA_FORMS` sends the bytes dnsmasq would: options
  121 (routes), 43, 63, 77 and 82 (opaque), 150 and 252 (no Kea definition), and DHCPv6 NTP
  (56) as RFC 5908 suboptions. Custom options are bytes of their declared type, numbers at
  dnsmasq's widths. Every catalog option of both families passes `kea-dhcp4 -t` and
  `kea-dhcp6 -t` (checked against Kea 3.0.4).
- Kea sends option 28 only when told, so it is written from the network's broadcast address.
  T1 and T2 are half and seven eighths of the lease, as dnsmasq sends them. Stateful DHCPv6
  scopes have Rapid Commit on, matching dnsmasq.
- The DHCPv6 server DUID is `DATA_DIR/kea/server-duid` when present (a switch carries dnsmasq's
  over), so clients renew with Kea instead of waiting to rebind.

What the spike and the verification runs established (Debian trixie container, Kea 3.0.4 from
ISC's Cloudsmith repository, 2026-10-07):

- **Packages.** `isc-kea-dhcp4`, `isc-kea-dhcp6`, `isc-kea-hooks` (Debian's own `kea-*` is 2.6).
  The binaries are `_kea:_kea` mode 0750, so the `cidrella` account joins group `_kea`. ISC's
  units are not enabled on install; CIDRella runs its own. Alpine 3.24 (node:24-alpine) has
  kea 3.0.3 with hooks as `kea-hook-*` subpackages.
- **Paths.** Kea 3 refuses lease, log, legal-log and socket paths outside the directories its
  `KEA_*` variables name (`backends/kea/paths.js` `keaEnv()`); the control-socket directory must
  be 0750 or stricter. `kea-dhcp4 -t` does not check those paths, so they are fixed in code.
- **Sockets.** `service-sockets-require-all` stops a daemon that could not open a socket on
  every interface instead of running deaf, and five retries five seconds apart cover an
  interface still coming up (a DHCPv6 link-local address arrives a moment after the link).
- **Router Advertisements.** dnsmasq binds UDP 547 whenever its RA carries M or O. Kea binds
  the link-local and `ff02::1:2` sockets on the same port beside it, and `dhcp-ignore` makes
  dnsmasq answer no DHCPv6, so RA stays on dnsmasq with no flag gating. Not yet tested: a
  Renew or Rebind while both hold 547.
- **Leases.** Kea reports `cltt` and `valid-lft`, never an expiry; `valid-lft` 4294967295 is
  infinite. `lease4-add` takes `expire - valid-lft` as the lease start, and an infinite lease
  goes in with the infinite lifetime and no `expire`. `lease*-get-page` treats `from` as
  exclusive; result 3 means nothing found.
- **Legal log.** Written only for committed leases (a REQUEST and its ACK), to
  `kea-legal4.<YYYYMMDD>.txt`, a new file each day. The fingerprint watcher follows the newest
  (`createLogFollower`), and DHCP message counts come from the `pkt4/pkt6-received` and `-sent`
  statistics (`dhcpCounters()`), since a DISCOVER never reaches the log.
- **Reload.** A SIGHUP or `config-reload` with a bad file keeps the old configuration running.

