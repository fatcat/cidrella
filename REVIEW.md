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

## Found building the Kea adapter (2026-10-07)

#### DNSMASQ-08: dnsmasq sends DHCPv4 number options at the wrong width

**medium**, confirmed in dnsmasq's source (`src/option.c`, the `is_dec` branch) and in
`server/src/backends/dnsmasq/option-names.js:dnsmasqOptionToken`.

- **What happens:** Set Time Offset (2) to `3600` or ARP Cache Timeout (35) to `600`. RFC 2132
  makes both four-byte fields; dnsmasq sends two bytes. MTU (26) at `200` goes out as one byte,
  not two. A client either refuses the option or reads the wrong number. The same rule turns a
  text option whose value is all digits into a number. Under Kea the same values go out at the
  right width, because Kea encodes by its own option definitions.
- **Why:** CIDRella writes every DHCPv4 option by number (`dhcp-option=tag:scopeN,2,3600`).
  Given a bare number, dnsmasq looks up no type, so it reads the value by its shape and sizes a
  number by magnitude: one, two or four bytes. dnsmasq's own table would size these correctly,
  but only applies to an option written by name (`option:time-offset`).
- **Fix:** Give the catalog's number options a width, and have the dnsmasq adapter add
  dnsmasq's width suffix (`b`, `s`, `i`) to the value. Or write the DHCPv4 options dnsmasq
  knows by name, as `option-names.js` already does for DHCPv6. Either changes the dnsmasq
  goldens, so it belongs in its own commit.

## Found building DHCP Bulk Change (2026-10-05)

#### DHCP-01: A default option with a value is served to every scope, ticked or not

**medium**, confirmed. `server/src/models/dhcp-scope.js:281`

- **What happens:** Settings, DHCP, Scopes & Leases: give NTP Servers (42) a value and untick
  Enabled by Default. Every existing scope with no 42 row of its own now serves that NTP pool,
  and so does every new scope. In Bulk Change, unticking 42 under Apply cannot take NTP off a
  scope while the default has a value: the preview shows the scope's own value replaced by the
  default's, not removed.
- **Why:** `resolveEffectiveScopeOptions` seeds every scope from all `dhcp_option_defaults`
  rows with a value (`global_default`), ignoring `enabled_by_default`. The checkbox only decides
  what is copied into a new scope's rows. The editor's wording ("Enabled by Default", and until
  this change "will not affect existing scopes") says a default is a template, not a global.
- **Fix:** Decide which it is. Global is relied on today: the 0.5.0 release notes say existing
  stateless and stateful DHCPv6 scopes pick up NTP (56) through it after the upgrade. If it
  stays global, label the value column as served to every scope and let a scope or Bulk Change
  suppress one. If it becomes a template, seed only from rows with `enabled_by_default = 1` (or
  from none, since new scopes carry their own rows), and roll new defaults out with Bulk Change
  instead.

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
