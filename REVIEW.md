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

#### DNSMASQ-01: dnsmasq warns of duplicate dhcp-host addresses that appear once in the file

**low**, plausible (seen on prod, cause not found). `server/src/utils/dhcp.js` (`regenerateReservations`)

- **What happens:** Prod's dnsmasq log has `duplicate dhcp-host IP address 10.0.8.222 at line
  23` and `10.0.8.223 at line 24` of `dhcp-hosts.d/reservations.hosts`, 12 times each in
  about 11 hours. Each address is on one line of that file and in no other dnsmasq config.
  They are the last two lines, and both thermostat reservations predate CIDRella, so the
  warning is not about recently added entries.
- **Why:** Not established. The likeliest lead: `atomicWrite` (`utils/dnsmasq.js:24`) writes
  `reservations.hosts.tmp.<pid>` inside the watched `dhcp-hostsdir` before renaming it, and
  dnsmasq loads every file in that directory except names starting with `.` or ending in `~`,
  so it can read the temp file and then the renamed one. dnsmasq keeps the first entry, so
  nothing is served wrong today; it would matter if one of those reservations changed its MAC.
- **Fix:** Reproduce on testerella (save a reservation, watch the log), then give the temp file
  a name dnsmasq skips (a leading `.`), and check the other watched directories (`hosts.d`)
  use the same write.
