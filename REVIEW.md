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
