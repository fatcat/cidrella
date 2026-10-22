# Review findings

Open issues found by review, audits and agents, and not fixed yet. How to use this file is in
`AGENTS.md` (Review findings): record an issue here when you find it and do not fix it in the
same change; when it is fixed, delete its entry in the commit that fixes it and name the ID in
the commit message. Git history is the record of what was fixed.

Each entry: an ID, the severity (**high**: wrong data, a broken feature or a security issue;
**medium**: a parity gap or wrong display; **low**: cosmetic, gating or a test gap), whether it
was confirmed in the code or is only plausible, where it is, what happens, why, and the fix that
was suggested.

---

## Found tracing a rogue DHCP alert (2026-10-14)

#### ROGUE-PROBE-V4-01: The IPv4 rogue probe did not see a Kea server that was serving the LAN

**high**, seen on the LAN; the cause is plausible, not confirmed. `server/src/utils/dhcp-probe.js`
(the DISCOVER send, `dest = iface.broadcast || '255.255.255.255'`).

- **What happens:** From 2026-10-10 to 10-14, testerella's Kea DHCPv4 handed out real leases on
  10.0.0.0/22 (forensic log, `DHCP4_LEASE_OFFER` to client MACs at 10:37 and 10:40 UTC on 10-14).
  Prod's probe ran every 15 minutes on the same segment and reported only the DHCPv6 server on
  that host. Kea logged no offer at prod's probe time (10:38:59 UTC).
- **Why (plausible):** The DISCOVER goes to the subnet's directed broadcast (10.0.3.255 on prod),
  not to 255.255.255.255 as a client's does. Kea on a raw socket may ignore a directed broadcast,
  and other servers may too.
- **Fix:** Send the DISCOVER to 255.255.255.255 out the probed interface (bind the socket to the
  interface address, or `SO_BINDTODEVICE`), as a client does. Then check against a real Kea and
  dnsmasq that each answers the probe.

---

## Found building the audit trail (2026-10-11)

#### PROXY-BYPASS-01: Proxy bypass never ends on its own

**high**, confirmed in the code, not yet reproduced. `server/src/utils/dns-proxy.js`
(`startHealthMonitor`, `deactivateBypass`).

- **What happens:** Once the health check puts the backend on port 53 (bypass), it stays there.
  Filtering, GeoIP blocking and the query log stay off until someone deletes the
  `dns_proxy_bypass` setting by hand, through restarts and updates too.
- **Why:** The health check returns at `if (bypassMode) return;` before it tries the proxy
  again, so the `if (bypassMode) deactivateBypass()` after a successful restart can never run.
  The setting is stored, so after a restart the backend takes port 53 first, the proxy cannot
  bind, and the next check turns bypass back on.
- **Fix:** While bypassed, probe whether the proxy could serve (bind a test socket on an
  alternate port, or check that the condition that killed it has cleared), then clear the
  setting, apply the listen config so the backend leaves port 53, start the proxy and call
  `deactivateBypass`. Clear `dns_proxy_bypass` at boot so a restart always tries the proxy
  first. Both transitions already write audit rows.

#### TEST-MIGRATION-HELPER-01: Ten migration tests each build their own database

**low**, confirmed in the code. `server/tests/integration/*-migration.test.js` and
`ip-lifecycle-upgrade.test.js` (ten files).

- **What happens:** Each defines its own `databaseThrough` / `createDatabaseThrough` (temp dir,
  `schema_version`, apply the migrations up to n). They differ in small ways (some wrap each
  migration in a transaction, some do not), so a change to how migrations apply must be made
  ten times.
- **Why:** Written one at a time before a shared helper existed.
- **Fix:** Replace each copy with `databaseThrough` from `tests/helpers/migrations.js` (added
  with migration 089's test) and delete the local one.

## Found building the PowerDNS log (2026-10-11)

#### DOCKER-LOGROTATE-01: Docker never rotates dnsmasq.log or pdns.log

**low**, confirmed in the code. `rootfs/etc/s6-overlay/` has no rotation; only native installs
get `/etc/logrotate.d/cidrella-*` (`scripts/lib/systemd-install.sh` `install_logrotate_configs`).

- **What happens:** In the container `/data/dnsmasq/dnsmasq.log` (and on the PowerDNS + Kea stack
  `/data/pdns/pdns.log`, with a line per query) grow until someone clears them in Settings > Logs.
  Backups leave them out, so the cost is disk space in the data volume.
- **Why:** Rotation was added for native installs after the 2026-04-21 backup incident; the
  image has no logrotate or cron.
- **Fix:** A small s6 oneshot loop (or a CIDRella timer, which already knows both paths through
  `logSource()`) that copies and truncates a log past 50 MB and keeps a few compressed copies.

#### PDNS-LOG-01: Recursor logs about 31 warnings at every start and zone reload

**low**, confirmed on testerella (Recursor 5.3.11, 2026-10-11) in `pdns.log`.
`server/src/backends/pdns/render.js` (`renderRecursorConfig`).

- **What happens:** Each start and each `rec_control reload-zones` (a zone added or removed)
  writes ~31 `msg="Will not overwrite already loaded zone"` warnings, one per private reverse
  zone (`10.in-addr.arpa`, the RFC 6303 `ip6.arpa` ones and the like). They push the query lines
  out of the Logs > DNS backlog. Nothing is served wrong: CIDRella's forward zones win.
- **Why:** CIDRella forwards those zones to Authoritative (the reserved and derived zones), and
  Recursor then tries to add its built-in RFC 1918 and RFC 6303 zones by the same names.
- **Fix:** If CIDRella's reserved zones cover every built-in one (check against Recursor's list),
  render `recursor.serve_rfc1918: false` and `serve_rfc6303: false` so it stops adding them;
  otherwise drop those lines in the viewer.

## Found adding the filtering pause (2026-10-09)

#### UI-TOAST-01: Five views show every toast twice

**low**, confirmed in the browser on the Filtering page (fixed there in the same change). Views:
`client/src/views/RogueDhcp.vue:267`, `Users.vue:366`, `SubnetCalculator.vue:77`, `GeoIP.vue:200`,
`SubnetDetail.vue:584`.

- **What happens:** Any toast raised on these views appears twice, stacked.
- **Why:** `App.vue` mounts the one global `<Toast>`, and each of these views mounts its own as
  well; both render every message from the shared toast service.
- **Fix:** Delete the `<Toast />` element and its import from each view. `Settings.vue` already
  says the global one is the only one.

## Found building the Kea adapter (2026-10-07)

#### DNSMASQ-08: dnsmasq sizes a DHCPv4 option it does not know by the value's shape

**low**, confirmed in dnsmasq's source, 2.91 through 2.93 (`src/option.c` `parse_dhcp_opt`, the
`is_dec` branch; `lookup_dhcp_len` in `src/dhcp-common.c`). CIDRella writes DHCPv4 options by
number: `server/src/utils/dhcp.js:188` on 0.5.0, the dnsmasq backend on 0.5.1 and later.

- **What happens:** For an option dnsmasq knows, the number is looked up in its own table, so
  Time Offset (2), MTU (26), ARP Cache Timeout (35) and the rest go out at the right width.
  An option it does not know is read by the shape of its value: an all-digit value becomes a
  number sized by magnitude (one, two or four bytes). In the catalog that hits Path MTU Aging
  Timeout (24), a four-byte field: `600` goes out as two bytes. A text option dnsmasq does not
  know (Merit Dump File 14, NetWare/IP 62 and 63, WPAD URL 252) with an all-digit value goes
  out as a number. Custom options are read the same way.
- **Why:** dnsmasq has no type for a code outside its table, so it guesses from the value.
- **Fix:** For a code dnsmasq does not know, have the renderer give the type: dnsmasq's width
  suffix (`b`, `s`, `i`) for a number option, from a width in the catalog (`i` for 24), and a
  form dnsmasq keeps as a string for a text option (check which one it honors). This changes
  the dnsmasq output for those options only; on 0.5.1 and later the goldens show it.

## Found reading prod's logs (2026-10-06)

#### DNSMASQ-02: A reservation change reaches dnsmasq twice and logs a duplicate per line

**low**, confirmed from prod's dnsmasq log (2026-10-06). `server/src/backends/dnsmasq/dhcp.js:418`
(`regenerateReservations`)

- **What happens:** Changing a DHCP Reservation logs `duplicate dhcp-host IP address ... at
  line N of .../dhcp-hosts.d/reservations.hosts` once for every line of the file (24 on prod at
  11:26:36). CIDRella wrote the file at 11:26:34.74 and reloaded dnsmasq (SIGHUP) at
  11:26:34.84, which read every reservation; dnsmasq then handled the queued inotify event for
  the same write and read the file again on top. Both copies are identical and dnsmasq keeps
  the first, so nothing is served wrong.
- **Why:** The change reaches dnsmasq by SIGHUP and by inotify on `dhcp-hostsdir`. The reload is
  still needed: dnsmasq notices a removed reservation only on SIGHUP.
- **Fix:** Cosmetic, once per reservation change; leaving it is reasonable. To silence it, write
  reservations to a file dnsmasq reads only on reload (`dhcp-hostsfile` instead of
  `dhcp-hostsdir`), which also drops the inotify path.
- **Decided 2026-10-08: leave it.** The fix rewrites every managed install's live dnsmasq.conf
  and cannot reach include-mode installs, for log noise only.
