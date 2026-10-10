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
| Filtering, query logging, liveness, the Resolution Map feed     | custom proxy            | **the custom proxy**, unchanged on both stacks                  |
| Caching, DNSSEC validation, routing local zones                 | dnsmasq                 | **PowerDNS Recursor**, behind the proxy                         |
| Forwarding to upstreams (plain, DoT, DoH; failover, balance)    | in-Node forwarder       | **the in-Node forwarder**, unchanged on both stacks             |

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
| 6 | **Query log readers** | `logSource()` (`path`, `querySourceIp`, `dhcpDirection`, `isDhcpLine`) | `backends/dnsmasq/log-format.js` regexes, read by passive liveness, the metrics aggregator and the log viewer | PowerDNS: none needed for queries, since the proxy already records every client query; Recursor's own log for the log viewer. Kea logs | what reads dnsmasq's log must read the proxy's records or the new daemons' logs; a null `logSource()` turns those readers off |
| 7 | **Recursion + filtering proxy** | none (stays in `utils/dns-proxy.js`) | bespoke UDP/TCP proxy in front of dnsmasq (blocklist, GeoIP, DNSSEC TCP relay, EDNS, bypass) | unchanged: the proxy stays on port 53 and forwards to Recursor instead of dnsmasq (decided 2026-10-09, see "Resolver on the PowerDNS stack") | the proxy's upstream address becomes a DNS-backend fact rather than `resolveDnsmasqInternalPort` |
| 8   | **DNSSEC**                          | `dns.applyResolver`, `capabilities().dnssec`, `dns.onClockSynchronized` | `dnssec`/`trust-anchor` directives, `dnssec-no-timecheck` until NTP sync, then SIGHUP                                                                                                                 | Recursor `dnssec=validate` (+ Auth signing)                      | validate only, no online signing                                                            |
| 9 | **Forwarders / upstreams** | `dns.applyResolver` | one `server=127.0.0.1#5356` line at the in-Node forwarder, which sends to the primary and backup over plain DNS, DoT or DoH | Recursor `forward-zones-recurse` for `.` at the same in-Node forwarder; Recursor has outgoing DoT but no DoH | none: the forwarder stays for both stacks |
| 10 | **Listen addresses and interfaces** | `dns.applyListen`, `activate` | `interface=`/`listen-address=`/`no-dhcp-interface=` in `dnsmasq.conf`; restart | PowerDNS Recursor and Authoritative on 127.0.0.1 only (the proxy keeps the LAN addresses); Kea `interfaces-config` | one daemon today, three on the PowerDNS + Kea stack |
| 11  | **Process control and health**      | `status`, `activate`, `restart`, `applyActivation`, `prepare`           | systemd `cidrella-dnsmasq` unit (s6 in Docker); health and restart ask systemd, `pidof` only without systemctl                                                                                                               | REST is live; health is the API answering                        | no SIGHUP/restart once the adapter is REST                                                  |

**DHCP to DNS derivation and PTR sync** (`utils/ip-sync.js`, `services/subnet-dns-topology.js`,
`syncDhcpDnsRecords`) is app-mediated and neutral. It stays the **highest-risk seam** for a
split-backend world: Kea DDNS into PowerDNS or keeping the app in the loop has to be decided
before Kea lands.

## What still knows about dnsmasq outside the layer

Deliberate, each with a reason:

- `utils/dns-proxy.js` and `utils/encrypted-forwarder.js`: the proxy forwards to dnsmasq's
  internal port (`resolveDnsmasqInternalPort` in `config/defaults.js`). Both stay on the
  PowerDNS stack (seam 7); only that port becomes the DNS backend's to report, so the proxy
  forwards to Recursor there.
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
4. **Build new features adapter-swappable.** E.g. forwarders are a self-contained in-Node
   forwarder (plain, DoT or DoH, primary and backup) that dnsmasq points `server=` at, and
   Recursor will point `forward-zones-recurse` at. Filtering and query analytics belong in the
   proxy, which both stacks keep, never in one backend's hooks.

## Migration approach

1. ~~Spike PowerDNS Recursor + RPZ to retire `dns-proxy.js`.~~ Decided against on 2026-10-09:
   the proxy stays and Recursor sits behind it (see "Resolver on the PowerDNS stack"). Recursor
   in that slot was spiked on 2026-10-10 and works; the results and what the adapter must do are
   under "Recursor spike" below.
2. ~~Introduce the backend API as a thin facade over today's dnsmasq code.~~ Done in 0.5.1.
3. **Kea first** (DHCP role, 0.5.2): the adapter is in `backends/kea/` and passes the contract
   test. DNSMASQ-06 and -07 are fixed, and DDNS stays with CIDRella (no Kea D2). The
   `dhcp_backend` setting and the switch with its lease handover are in. Still to come: the
   packaging.
4. **PowerDNS** (DNS role) after that; deprecate dnsmasq over one release, no permanent dual
   stack.

## Resolver on the PowerDNS stack (decided 2026-10-09)

On the PowerDNS + Kea stack, CIDRella's proxy keeps port 53 and PowerDNS Recursor takes the
place dnsmasq has behind it today:

```
client ─► CIDRella proxy :53 ─► Recursor (127.0.0.1) ─┬─► Authoritative (127.0.0.1)   local zones
          blocklists, GeoIP,    cache, DNSSEC         └─► in-Node forwarder :5356     everything else
          pause, exemptions,    validation,                plain, DoT or DoH,
          query log, liveness,  forward-zones              primary and backup
          Resolution Map feed
```

Two alternatives were weighed and rejected:

- **Recursor replaces the proxy** (what this page used to plan, with RPZ and Lua). Filtering,
  the pause and per-host exemptions, the query log, liveness, failure causes and the
  Resolution Map would all be rebuilt in Lua or from a protobuf/dnstap consumer, and the two
  stacks would filter and log in different code. Recursor also cannot forward over DoH (it has
  outgoing DoT only), so DoH upstreams and the forwarder's failover, balancing and metrics would
  be lost. The gain is one localhost hop.
- **The proxy does everything, no Recursor.** It would need its own cache and a DNSSEC
  validator in Node; dnsmasq does both today, and a validator is the part not worth owning.

What the Recursor adapter does, then, is dnsmasq's resolver half: forward zones for each local
zone to Authoritative, `.` to the forwarder, the trust anchor and validation mode, the clock
gate, cache flushes, and a listen address on 127.0.0.1 that the proxy reads from the backend.

### Recursor spike (2026-10-10)

A throwaway Debian 13 container (2 cores, 2 GB) ran the option C chain with Debian's packages,
Recursor 5.2.13 and Authoritative 4.9.17 (gsqlite3 backend, HTTP API on). Authoritative listened
on 127.0.0.1:5300, Recursor in dnsmasq's slot on 127.0.0.1:5353, and a no-cache dnsmasq with
`--proxy-dnssec` stood in for the in-Node forwarder on :5356, forwarding to 1.1.1.1 and 9.9.9.9.
The baseline was dnsmasq as CIDRella runs it today: default cache, DNSSEC on, `server=` the same
stand-in. Queries came from a timing script, top names from the Tranco list.

**It works.** A, AAAA, a CNAME inside a local zone, a CNAME out to public DNS, NXDOMAIN, and IPv4
and IPv6 PTRs all answered through the forward zones; public DNSSEC still validated
(`dnssec-failed.org` SERVFAIL, signed names fine). Recursor accepts a forwarder on 127.0.0.1 even
though its default `dont_query` covers 127.0.0.0/8: an explicit forwarder overrides it.

**Measured** (cold means neither cache had the names; the upstreams were warmer for whichever ran
second):

| Run | Recursor p50 / p90 / p99 | dnsmasq p50 / p90 / p99 |
|---|---|---|
| 1000 names, 20 in flight, cold | 17.5 / 133 / 344 ms | 49.2 / 302 / 1252 ms |
| same 1000 again, warm | 0.3 / 0.8 / 16.1 ms | 46.2 / 260 / 1169 ms |
| 5000 new names, 20 in flight, cold, timeout fixed | 23.8 / 231 / 870 ms, 10 SERVFAIL | 72.0 / 425 / 1419 ms, 21 failed |

dnsmasq barely improves warm because its default cache holds 150 entries. Recursor's memory:
28 MB idle, 40 MB after 11,000 names (cache 10,804 entries); the container never went above
100 MB in use.

**What the adapter must do**, each found by the spike failing without it:

- **A negative trust anchor per local zone**, forward and reverse. Recursor validates forwarded
  answers too, and the root proves securely that `test.` (or any made-up TLD) does not exist, so
  every unsigned local answer was Bogus and SERVFAIL. `10.in-addr.arpa` passed only because it is
  delegated insecurely; do not rely on that. `rec_control add-nta` applies one at runtime.
- **`outgoing.network_timeout` between the forwarder's budget and the proxy's.** At Recursor's
  default 1.5 s, 109 of 10,000 cold lookups timed out and became SERVFAIL while the forwarder was
  still trying; the forwarder allows 2.5 s per attempt and 4.5 s in all
  (`ENCRYPTED_FORWARDER_TIMEOUT_MS`, `_BUDGET_MS`), and the proxy waits 5 s
  (`PROXY_UDP_TIMEOUT_MS`). 4.6 s fixed it. Keep the three in that order.
- **`outgoing.dont_throttle_netmasks` for 127.0.0.1 and ::1.** Recursor throttles a server that
  refused or failed, per name, for about a minute. After Authoritative refused a zone it had not
  loaded yet, local names stayed SERVFAIL after it recovered.
- **Wipe Recursor's cache under a zone after every DNS write** (`rec_control wipe-cache
  'zone$'`). An edited record kept its old answer until its TTL ran out, and a newly added name
  kept the cached NXDOMAIN.
- **New forward zones**: `rec_control reload-zones` re-reads them from the config files without a
  restart.
- **Write zones and records through Authoritative's HTTP API only.** The API refreshes its zone
  cache and clears its packet cache, so a change answers at once. `pdnsutil` or direct SQL does
  not: a zone made that way was REFUSED until a restart (the zone cache refreshes every 300 s, and
  `pdns_control rediscover` did not help). Even through the API, a zone deleted and recreated
  within 20 s answers REFUSED until the packet cache (`cache-ttl`) expires, and the sqlite backend
  reuses domain ids.
- **YAML configuration.** Recursor 5 reads `recursor.conf` as YAML and the files in
  `recursor.d/` as `.yml`; quote any value with a colon, such as `"::1/128"`.

Not covered: PowerDNS's own repositories (Recursor 5.3, Authoritative 5.0) rather than Debian's;
DoT straight from Recursor (not used under option C); TCP and large answers through the chain;
Recursor's packet cache settings and `max_cache_entries` for a small appliance; how
`serve_rfc1918` interacts with a local reverse zone for a network outside 10/8.

## Kea (0.5.2)

> **Two stacks (decided 2026-10-07).** A host will run either dnsmasq for everything or
> PowerDNS + Kea (0.5.3, released as 0.6.0), never dnsmasq beside Kea. What follows describes
> 0.5.2, where Kea fills the DHCP role next to dnsmasq's DNS; that mixed mode (dnsmasq's
> not-serving render, both daemons on UDP 547) is interim, hidden from the UI, and goes in
> 0.5.3. The adapter, the lease handover and the packaging carry over. The plan is in
> `BACKLOG.md` (PowerDNS + Kea stack).

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

### Switching (Settings > DHCP > Server)

`services/dhcp-backend-switch.js` moves the DHCP role and its leases, so exactly one server
answers at any time (none for the seconds between):

1. Preflight, read-only: the target is installed (`installed()`), and what the switch gains and
   loses, from the feature report.
2. A marker, `DATA_DIR/dhcp-switch.json`.
3. The source stops answering (`setDhcpServing(name, false)` and a render). dnsmasq renders its
   DHCPv6 scope files for the Router Advertisements plus `dhcp-ignore=tag:!nosuchtag`; Kea
   renders `interfaces: []`.
4. The source's final lease set, kept in `DATA_DIR/handover/<time>.json` (0600).
5. The target is selected, still not answering, starts, and takes the leases with
   `importLeases(leases, { serverDuid })`: Kea deletes what it held and adds them through
   `lease_cmds`; dnsmasq gets a lease file whose `duid` line carries the server DUID, which it
   loads when it restarts.
6. The target answers (`awaitRunning()`: for Kea, `status-get` reports `sockets.status` ready).
7. The setting is written, the marker cleared, and a source that fills no role is stopped.

A failure in steps 3 to 6 selects the source again and renders it serving. At boot,
`selectDhcpBackendAtBoot` reads the setting, falls back to dnsmasq when the named backend is not
installed, and, if a marker is left, stops the other backend and re-renders DHCP. The lease sync
is held for the whole switch (`holdLeaseSync`): a read of the target before it has the leases
would release every lease in the database.

Not yet verified on real hardware: a client's Renew and Rebind across a switch in both
directions, and that dnsmasq loads a handed-over lease file on the restart that makes it serve.

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

- **Capabilities.** Run as a non-root account, Kea needs only `CAP_NET_BIND_SERVICE` and
  `CAP_NET_RAW`, the pair ISC's own units grant (checked on Alpine's 3.0.3: port 67 bound on a
  raw socket). A file capability the container's bounding set lacks makes the binary refuse
  to run at all, so the image grants no more than compose's `cap_add` holds.

### Packaging

- **Native.** `scripts/lib/kea-install.sh`, sourced by `install.sh` and `update.sh`, adds ISC's
  `kea-3-0` Cloudsmith repository (key checked against fingerprint
  `9DA570BB192211885E4EB280B16C44CD45514C3C`), installs the three packages, masks ISC's
  units, adds `cidrella` to `_kea`, and installs `scripts/systemd/cidrella-kea@.service`
  (instances `dhcp4` and `dhcp6`, not enabled). It never starts or restarts Kea; a failure
  warns and the install or update goes on, with the switch reporting Kea as not installed.
  polkit lets `cidrella` start, stop, restart and reload the two instances.
- **Docker.** Alpine's `kea-dhcp4`, `kea-dhcp6` and `kea-hook-*` packages, with file
  capabilities on the binaries. The s6 longruns `kea-dhcp4` and `kea-dhcp6`
  (`rootfs/etc/s6-overlay/scripts/kea.sh`) wait for `DATA_DIR/runtime/kea-dhcp<N>.enabled`,
  which `createUnitControl`'s `enableFile` writes on restart and removes on stop; `init-data`
  clears the flags at container start, so Kea comes up only when CIDRella asks.
- **Backups** carry `kea/` (lease files, `server-duid`) without `kea/secret`, `kea/log`,
  `kea/run` or the rendered config. A restore keeps the host's secret and leaves
  `runtime/restart-backends-on-boot`, so the next boot renders DHCP and restarts every
  backend on what was restored.
- **Retention.** Kea starts a legal log file a day and never removes one; `pruneLogs` deletes
  them past the audit log retention, from the same daily prune.
