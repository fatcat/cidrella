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
| 1   | **DNS records/zones**               | `dns.applyZones`                                                        | `backends/dnsmasq/dnsmasq.js` renders `hosts.d/records.hosts` (A/AAAA, each address's canonical PTR name first) and `conf.d/zone-*.conf` (CNAME/MX/TXT/SRV, PTRs the hosts file can't answer); SIGHUP | PowerDNS (0.5.3): Authoritative's HTTP API, only the changed rrsets (`backends/pdns/diff.js`), from the shared model `backends/shared/dns-zone-model.js`; Recursor's cache wiped under the zone | dnsmasq serves one TTL (`local-ttl=60`) for every record but a CNAME, so its `servedTtl` reports that; PowerDNS serves each record's own |
| 2   | **DHCP scopes and reservations**    | `dhcp.applyScopes`                                                      | `backends/dnsmasq/dhcp.js` renders `dhcp-range=`, `dhcp-host=`, options; restart or SIGHUP                                                                                                            | Kea (0.5.2): `kea-dhcp{4,6}.conf` rendered from the same scope model (`backends/shared/dhcp-scope-model.js`), checked with `kea-dhcp4 -t`, reloaded with SIGHUP | dnsmasq sends DHCPv4 numbers at the wrong width (DNSMASQ-08) |
| 3   | **Lease ingestion**                 | `dhcp.readLeases`, `dhcp.watchLeases`                                   | `backends/dnsmasq/lease-file.js` reads `dnsmasq.leases` once it settles; `fs.watchFile`                                                                                                               | Kea (0.5.2): `lease4/6-get-page`; `watchLeases` polls the lease statistics | a page scan is not atomic, so a scan during which Kea handed out an address reads as unsettled |
| 4   | **Lease release**                   | `dhcp.releaseLease`                                                     | `backends/dnsmasq/lease-release.js` (`dhcp_release`/`dhcp_release6`)                                                                                                                                  | Kea (0.5.2): `lease4-del` / `lease6-del`                         | none                                                                                        |
| 5   | **DHCP fingerprint capture**        | `logSource().createDhcpParser`                                          | `backends/dnsmasq/dhcp-log-parser.js` parses `log-dhcp` text (opt55/60/hostname)                                                                                                                      | Kea (0.5.2): the `legal_log` hook, formatted to one line per committed lease (`backends/kea/legal-log-parser.js`) | Kea logs committed leases only, so DHCP message counts come from `dhcpCounters()` instead |
| 6 | **Query log readers** | `logSource()` (`path`, `querySourceIp`, `dhcpDirection`, `isDhcpLine`) | `backends/dnsmasq/log-format.js` regexes, read by passive liveness, the metrics aggregator and the log viewer | PowerDNS (0.5.3): `logSource()` is null, since the proxy records every client query; the log viewer awaits its own item. Kea logs | what reads dnsmasq's log must read the proxy's records or the new daemons' logs; a null `logSource()` turns those readers off |
| 7 | **Recursion + filtering proxy** | none (stays in `utils/dns-proxy.js`) | bespoke UDP/TCP proxy in front of dnsmasq (blocklist, GeoIP, DNSSEC TCP relay, EDNS, bypass) | unchanged: the proxy stays on port 53 and forwards to Recursor, which PowerDNS (0.5.3) puts on the same internal port dnsmasq used | none for now: Recursor takes `resolveDnsmasqInternalPort()`, so the proxy's upstream did not move |
| 8   | **DNSSEC**                          | `dns.applyResolver`, `capabilities().dnssec`, `dns.onClockSynchronized` | `dnssec`/`trust-anchor` directives, `dnssec-no-timecheck` until NTP sync, then SIGHUP                                                                                                                 | PowerDNS (0.5.3): Recursor `dnssec.validation`, `process` until the clock is synchronized, then `validate`; local zones carry negative trust anchors                      | validate only, no online signing                                                            |
| 9 | **Forwarders / upstreams** | `dns.applyResolver` | one `server=127.0.0.1#5356` line at the in-Node forwarder, which sends to the primary and backup over plain DNS, DoT or DoH | Recursor `forward-zones-recurse` for `.` at the same in-Node forwarder; Recursor has outgoing DoT but no DoH | none: the forwarder stays for both stacks |
| 10 | **Listen addresses and interfaces** | `dns.applyListen`, `activate` | `interface=`/`listen-address=`/`no-dhcp-interface=` in `dnsmasq.conf`; restart | PowerDNS (0.5.3): Authoritative on 127.0.0.1 only; Recursor on loopback at the internal port, or in bypass mode the LAN port on the DNS interfaces; Kea `interfaces-config` | one daemon today, three on the PowerDNS + Kea stack |
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
   test. DNSMASQ-06 and -07 are fixed, DDNS stays with CIDRella (no Kea D2), and the packaging
   is in.
4. **PowerDNS** (DNS role, 0.5.3): the adapter is in `backends/pdns/` and passes the contract,
   golden and live tests; packaging is in. radvd sends the Router Advertisements on that stack
   (`backends/radvd/`).
5. **The stack choice** (0.5.3): the `backend_stack` setting picks dnsmasq or PowerDNS + Kea
   for every role at once, and Settings > General > Servers (and the setup wizard) switch
   between them with the leases. See "Switching stacks" below. Deprecate dnsmasq over one
   release, no permanent dual stack.

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

Not covered: DoT straight from Recursor (not used under option C); TCP and large answers through the chain;
Recursor's packet cache settings and `max_cache_entries` for a small appliance; how
`serve_rfc1918` interacts with a local reverse zone for a network outside 10/8.
PowerDNS's own repositories (Recursor 5.3, Authoritative 5.0) were covered later by the adapter's
live test; see PowerDNS (0.5.3) below.

## Kea (0.5.2)

> **Two stacks (decided 2026-10-07).** A host runs either dnsmasq for everything or
> PowerDNS + Kea + radvd (0.5.3, released as 0.6.0), never dnsmasq beside Kea. 0.5.2 ran Kea
> next to dnsmasq's DNS for a while; that mixed mode (dnsmasq's not-serving render, both
> daemons on UDP 547, the `dhcp_backend` setting and `/api/dhcp/server`) was removed in 0.5.3.
> An install left on it falls back to dnsmasq at boot with Kea's leases (see "Switching
> stacks").

`backends/kea/` fills the DHCP role with ISC Kea 3.0, one daemon per family, on the PowerDNS +
Kea stack. The configuration is file-canonical like dnsmasq's: `applyScopes`
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

### Switching stacks (Settings > General > Servers)

`services/stack-switch.js` moves DNS, DHCP and the Router Advertisements from one stack to the
other with the leases, so one stack answers at any time (none for the seconds between). The
registry (`backends/index.js`) maps a stack name to a backend per role (`STACKS`,
`selectStack`, `stackName`, `stackServices`); `backend_stack` holds the choice.

1. Preflight, read-only: every daemon of the target is installed (`installed()`), dnsmasq is
   CIDRella's own (`cidrella-dnsmasq.service` is loaded; an install that left dnsmasq to the
   host cannot switch), no switch is running, and what the switch gains and loses from the
   feature report.
2. A marker, `DATA_DIR/stack-switch.json`, then the after-commit hooks are held (`holdHooks`)
   and the lease sync too (`holdLeaseSync`): a read of the target before it has the leases
   would release every lease in the database. Interface changes answer 409 and the proxy does
   not fall back to bypass while the flag in `utils/switch-state.js` is set.
3. The target is staged without a contested port: PowerDNS Authoritative starts and takes every
   zone, Recursor's file is written; Kea is rendered and started listening nowhere; radvd's
   file is written; or dnsmasq's whole render is written with dnsmasq stopped.
4. The source stops and is awaited. Stopping dnsmasq writes `DATA_DIR/runtime/dnsmasq.disabled`,
   which its unit's `ConditionPathExists=!` and the s6 run script both honor, so nothing starts
   it behind CIDRella's back.
5. The source's final lease set is read (Kea's from its API, or its memfile when it is down) and
   kept in `DATA_DIR/handover/<time>.json` (0600), then imported into the target with
   `importLeases(leases, { serverDuid })`.
6. The target is selected and activated: Recursor, Kea serving, radvd; or dnsmasq.
7. Verify: the target is asked for the leases (any it does not show are reported, with the
   snapshot's path), and the SOA of every zone must answer (not SERVFAIL or REFUSED) through
   the backend DNS port on 127.0.0.1 (`backendDnsPort`).
8. Commit: `backend_stack` and `runtime/backend-stack` (read by `rollback.sh`) are written,
   the marker cleared, the holds released, and every daemon outside the stack stopped.

A failure after the source stopped puts the source back with the leases the target handed out,
and the error says so. At boot `selectStackAtBoot` reads the setting, falls back to dnsmasq
when a daemon of the stack is not installed, turns a legacy `dhcp_backend = kea` into the
dnsmasq stack after carrying Kea's leases over, cleans up after an interrupted switch, and stops
whatever is outside the stack. `/api/backend-stack` (GET, POST `{stack}`, admin only, audited)
is the API.

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
- **Router Advertisements.** On the PowerDNS + Kea stack radvd sends them (`backends/radvd/`,
  one block per DHCP interface holding an address in a DHCPv6 scope, flags and lifetimes as
  dnsmasq sends them, RDNSS and DNSSL from options 23 and 24). It runs only while there is a
  scope to advertise. Names for SLAAC hosts (`ra-names`) stay a dnsmasq feature.
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

## PowerDNS (0.5.3)

`backends/pdns/` fills the DNS role with PowerDNS Authoritative (CIDRella's zones) and Recursor
(in dnsmasq's slot behind the proxy). It passes the contract test, the golden test
(`pdns-golden.test.js`) and the live test (`PDNS_LIVE=1`, against Authoritative 5.0.7 and
Recursor 5.3.11). The PowerDNS + Kea stack selects it.

- **Ports, all on loopback.** Authoritative answers DNS on 5300 (`PDNS_AUTH_DNS_PORT`) and its
  HTTP API on 8053 (`PDNS_AUTH_API_PORT`), with the key in `pdns/secret/api-key`. Recursor
  takes `resolveDnsmasqInternalPort()`, the port the proxy already sends to, so `dns-proxy.js`
  does not change; in bypass mode it takes the LAN port on the DNS interfaces, as dnsmasq does.
- **Files.** Everything is under `DATA_DIR/pdns`: `auth/pdns.conf` and `auth/pdns.sqlite3`
  (created from the gsqlite3 schema by `prepare()`), `recursor/recursor.yml`, and `run/` for
  both control sockets. All of it is derived from `cidrella.db`, so backups leave it out.
- **Zones.** `applyZones` reads the shared model (`backends/shared/dns-zone-model.js`, which
  dnsmasq renders from too), builds the zones it wants (`render.js`), reads what Authoritative
  holds, and sends only the difference (`diff.js`): a POST per new zone, one PATCH per changed
  zone with REPLACE and DELETE rrsets, a DELETE per zone CIDRella no longer has. A second
  apply sends nothing; the live test checks that against the real API, so contents are
  written the way the API hands them back. A change of SOA serial alone (DHCP churn) is sent
  without touching Recursor's cache. `applyZones` returns a Promise, and the after-commit
  runner waits for it, so two zone writes never overlap.
- **Recursor.** `recursor.yml` forwards each local zone to Authoritative with a negative trust
  anchor, and `.` with recursion to the forwarder unless recursion is off. `dont_query` covers
  every address, so Recursor never queries the internet itself (forwarders are exempt). It
  carries a digest of its reloadable part (forward zones and anchors) and of the rest. A zone
  change runs `rec_control reload-lua-config` (anchors first, or a new zone answers Bogus),
  `reload-zones`, then `wipe-cache 'zone$'` for each changed zone; anything else restarts
  Recursor. Recursor checks every write (`--config=check`) and a refused one is rolled back.
- **DNSSEC.** Off: `process-no-validate`. On: `process` (log only) until the clock is
  synchronized, then `validate`; `onClockSynchronized` rewrites the file. Without timedatectl
  (Docker) it validates from the start, since the container shares the host's clock.
- **TTLs.** A record is served with its own TTL, else 60 s (`LOCAL_RECORD_TTL`, shared with
  dnsmasq); an rrset takes the lowest TTL among its records.
- **Derived zones.** Beside the user's zones, `desiredZones` adds what dnsmasq answers without
  being told: a PTR for each address an A or AAAA record names inside an allocated network
  (the first name per address, `servedHostsByAddress`, shared with dnsmasq; a stored PTR
  wins), placed in the covering CIDRella reverse zone, else a reverse zone for the whole
  network when it is private space, else one zone for that single address so the rest of a
  public block still resolves upstream; and an empty zone for each reserved name
  (`backends/shared/reserved-zones.js`), the site-local ones only while every upstream is
  public. Recursor's own built-ins (localhost, 127.in-addr.arpa, the ::1 reverse) are left to
  it. Derived zones are part of the desired set, so the diff keeps them.
- **What is left out.** Placeholder PTRs; every PTR at a name after the canonical one; other
  data beside a CNAME (the first CNAME wins); a record named outside its zone, which
  Authoritative refuses.
- **Versions.** Authoritative 5.1.4's API refuses a TXT value holding a double quote or a byte
  above 127 (it parses `\"` as the end of a string and prints `\195` as `\4294967235`); 5.0.7
  takes both. Native installs pin `auth-50` and `rec-53`; Alpine 3.24 has Authoritative 5.0.7
  and Recursor 5.4.5, which take the same configuration.

### Known gaps

dnsmasq does these and PowerDNS does not, or only in part:

- `forward_unknown` zones (split horizon): Recursor sends a zone to Authoritative or upstream,
  not one then the other. The proxy covers it: on NXDOMAIN for a name under such a zone it
  asks the forwarder again (`dns.forwardsUnknownItself === false`, recursion on). Not in
  bypass mode, and Recursor does not validate that second answer with DNSSEC.
- A reverse lookup for an address outside every allocated network: dnsmasq answers it from
  its hosts file; PowerDNS only synthesizes PTRs inside CIDRella networks.
- Names only dnsmasq serves: SLAAC hosts (`ra-names`) and bare DHCP hostnames.
- With recursion off, an outside name answers SERVFAIL.
- `logSource()` is null: the proxy records every query, and Settings > Logs says PowerDNS
  keeps no DNS log to show.

### Packaging

- **Native.** `scripts/lib/pdns-install.sh`, sourced by `install.sh` and `update.sh`, adds
  `repo.powerdns.com` (`auth-50`, `rec-53`, key fingerprint
  `9FAAA5577E8FCF62093D036C1B0C6205FD380FBB`, pinned above the distribution's packages),
  installs `pdns-server`, `pdns-backend-sqlite3` and `pdns-recursor`, masks `pdns` and
  `pdns-recursor`, and installs `cidrella-pdns-auth.service` and
  `cidrella-pdns-recursor.service` (not enabled, `User=cidrella`, Recursor with
  `CAP_NET_BIND_SERVICE` for bypass). polkit lets `cidrella` start, stop, restart and reload
  both. A failure warns and the install or update goes on.
- **Docker.** Alpine's `pdns`, `pdns-backend-sqlite3`, `pdns-doc` (the schema) and
  `pdns-recursor`, with `cap_net_bind_service` on `pdns_recursor`. The s6 longruns `pdns-auth`
  and `pdns-recursor` (`rootfs/etc/s6-overlay/scripts/pdns.sh`) wait for
  `DATA_DIR/runtime/pdns-<daemon>.enabled`, which `init-data` clears at container start.
