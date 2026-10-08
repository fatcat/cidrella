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

## Found building DHCP Bulk Change (2026-10-05)

#### DHCP-02: The scope dialog fills network-derived option values in its own copy of the rule

**low**, confirmed. `client/src/components/ScopeDialog.vue:668`

- **What happens:** The client builds DNS Servers as `${server_ip}, 9.9.9.9` in three places
  (lines 668, 830, 1092), with the fallback resolver hardcoded. The server's rule is
  `fillScopeOptions` in `services/subnet-dhcp-topology.js` with `FALLBACK_SECONDARY_DNS`. A
  change to the fallback, or to which options fill from the network, lands in one and not the
  other.
- **Why:** The dialog predates the shared server rule and fills its form before saving.
- **Fix:** Have the scope dialog ask the server for the filled set (the Bulk Change preview
  already computes it per scope), or move the rule to `@shared` and use it on both sides.

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

## Found building the backend facade (2026-10-06)

The facade (0.5.1) left these dnsmasq traits in place on purpose: changing them is a behavior
change, and the release promised none. Each needs fixing before, or as part of, the Kea or
PowerDNS adapter.

#### DNSMASQ-06: The DHCP option catalog API carries a dnsmasq field

**low**, confirmed in the code. `server/src/utils/dhcp-options.js` (every catalog entry),
`server/src/routes/dhcp.js:1336` (custom options in `GET /api/dhcp/options`)

- **What happens:** Each option in `GET /api/dhcp/options` carries `dnsmasqName`
  (`option:router`, `option6:23`), a dnsmasq config token. The client never reads it.
- **Why:** The catalog doubles as the dnsmasq renderer's lookup table
  (`backends/dnsmasq/dhcp.js` reads `optDef.dnsmasqName`), and the route returns it whole.
- **Fix:** Move the name mapping into `backends/dnsmasq/` (a code-to-token table the renderer
  owns), drop the field from the catalog and the route in the release that adds Kea. Deprecated
  as of 0.5.1.

#### DNSMASQ-07: Lease times are stored in dnsmasq's syntax

**low**, confirmed in the code. `server/src/db/migrations/007_dhcp.sql:8` (`lease_time TEXT`,
default `'24h'`), `server/src/routes/dhcp.js:58` (`LEASE_TIME_RE = /^\d+[smhd]?$/`),
`server/src/config/defaults.js:26` (`default_lease_time: '1h'`)

- **What happens:** `dhcp_scopes.lease_time`, the `default_lease_time` setting and option 51
  hold strings like `12h` or `3600`, which the dnsmasq renderer writes into `dhcp-range=` as
  they are. Kea wants `valid-lifetime` in seconds.
- **Why:** The column was designed around dnsmasq's lease-time format, so the database stores a
  backend's syntax rather than a duration.
- **Fix:** Keep the stored strings (backups and the UI depend on them) and give the backend layer
  one parser to seconds, shared by every adapter; the dnsmasq adapter keeps writing the string.
  A migration to integer seconds is the cleaner end state but touches backups, the UI and
  option 51 validation, so do it with the Kea adapter, not before.

## Found checking prod's DNS table (2026-10-07)

#### A11Y-01: Rows with no address get a "Select null" checkbox label

**low**, confirmed on prod. `client/src/views/networks-workspace/WorkspaceTable.vue:49`

- **What happens:** In a DNS table, the row checkbox of an MX, CNAME, TXT or SRV record is
  labeled "Select null" for screen readers; every such row has the same label. Seen on prod's
  the-mcnultys.org zone (the MX and CNAME rows).
- **Why:** The label is `` `Select ${row.address}` ``, and a record with no address has
  `address` null. Address and DHCP rows always have one, so it only shows in the DNS tables.
- **Fix:** Label the row by what names it in its table: the address when there is one, else the
  record's name and type (for example "Select the-mcnultys.org MX aspmx.l.google.com"). One
  helper in `WorkspaceTable.vue`, with a test that no row's label contains "null" or
  "undefined".
