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
- **Decided 2026-10-08: leave it.** The fix rewrites every managed install's live dnsmasq.conf
  and cannot reach include-mode installs, for log noise only.
