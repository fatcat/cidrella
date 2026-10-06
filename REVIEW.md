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

#### DNSMASQ-02: A reservation change reaches dnsmasq twice and logs a duplicate per line

**low**, confirmed from prod's dnsmasq log (2026-10-06). `server/src/utils/dhcp.js:466`
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

## Found writing the dnsmasq golden test (2026-10-06)

#### DNSMASQ-03: With DNSSEC on, every boot restarts dnsmasq

**medium**, confirmed in the code and by `server/tests/integration/backends/__golden__/05-boot-unchanged.txt`.
`server/src/index.js:233` (boot block), `server/src/utils/dnsmasq.js` (`applyInterfaceConfig`,
`regenerateDnsmasqConf`)

- **What happens:** With `dnssec_enabled` true, a reboot with no setting changed still reports
  the conf changed, validates it and restarts dnsmasq, dropping its cache. The file on disk ends
  up byte for byte the same.
- **Why:** Both writers strip their own lines and append them at the end of `dnsmasq.conf`. Boot
  runs `applyInterfaceConfig` (moves the interface lines below the DNSSEC block, a directive
  change) and then `regenerateDnsmasqConf` (moves the DNSSEC block back below them, another
  change). Each write compares against the one before it, so both report a change even though
  the pair is a round trip.
- **Fix:** Have the boot block compare the final `dnsmasq.conf` with what was on disk before
  either write (directives only, like `writeIfChanged`), or give each writer a fixed position
  for its block instead of appending. `routes/interfaces.js` has the same flaw on its own: it
  runs `applyInterfaceConfig` alone, which moves the interface lines below the DNSSEC block, so
  saving the Interfaces page with DNSSEC on restarts dnsmasq even when nothing changed
  (inferred from the same code path, not run). Fixing it changes the golden snapshot for step
  05, which should then show no restart.

#### DNSMASQ-04: SRV records are written without their zone

**high**, confirmed in the code and by `server/tests/integration/backends/__golden__/01-dns-zones.txt`.
`server/src/utils/dnsmasq.js:168` (`toFqdn`), `server/src/routes/dns.js:51` (`SRV_NAME_RE`)

- **What happens:** An SRV record `_sip._tcp` in zone `golden.test` is written as
  `srv-host=_sip._tcp,sip.golden.test,5060,1,2`, so dnsmasq answers `_sip._tcp` and not
  `_sip._tcp.golden.test`. Clients looking up the service in the zone get no answer.
- **Why:** The route only accepts the relative form (`_service._protocol`), and `toFqdn` treats
  any name containing a dot as already absolute, so the zone is never appended.
- **Fix:** In `toFqdn`, treat a name as absolute only when it ends with a dot or already ends
  in the zone; or qualify SRV names explicitly before calling it. Check the other record types
  for dotted relative names (`www.sub` in a zone) at the same time. Add v4 and v6 zone cases,
  and update the golden snapshot.
