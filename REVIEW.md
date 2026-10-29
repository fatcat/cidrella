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

## Found building IPv6 handling phase 2 (2026-10-28)

#### CALC-COUNT-01: the calculator reads a /64 as "more than 2^53" addresses

**low**, confirmed in the browser. `client/src/views/SubnetCalculator.vue` (`formatCount`),
fed by `parseNetwork` in `server/src/utils/cidr.js` (`size` and `usable` through `safeNumber`).

- **What happens:** Split `fd00:aa::/48` into /64s: the parent's Total IPs and Usable, and every
  child's Usable IPs, read "more than 2^53". A /64 holds exactly 2^64.
- **Why:** `parseNetwork` returns `size` and `usable` as null past `Number.MAX_SAFE_INTEGER`, and
  keeps the exact BigInt only in the non-enumerable `sizeBig`/`usableBig`, which JSON drops. The
  calculator has nothing exact to show, so it says what it knows.
- **Fix:** Have `/subnets/calculate` add the exact counts as decimal strings (`size_text`,
  `usable_text` or similar, on the parent and each child), and render them with
  `formatAddressCount` from `views/networks-workspace-data.js`, which already writes a power of
  two as `2^64`. Test with a /48 into /64s and an IPv4 /24.

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
