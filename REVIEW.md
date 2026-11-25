# Review findings

Open issues found by review, audits and agents, and not fixed yet. How to use this file is in
`AGENTS.md` (Review findings): record an issue here when you find it and do not fix it in the
same change; when it is fixed, delete its entry in the commit that fixes it and name the ID in
the commit message. Git history is the record of what was fixed.

Each entry: an ID, the severity (**high**: wrong data, a broken feature or a security issue;
**medium**: a parity gap or wrong display; **low**: cosmetic, gating or a test gap), whether it
was confirmed in the code or is only plausible, where it is, what happens, why, and the fix that
was suggested.

Entries under **Will not fix** are decided: the maintainer chose to leave them. They stay here so
the behavior they describe is explained when someone runs into it. Do not raise or fix them
again unless the maintainer reopens one.

#### TEST-FLAKE-PORT-CHANGE-01: The HTTPS port change test fails now and then under the full suite

**low**, test only, seen once 2026-11-25. `server/tests/integration/sync-client.test.js:430`

- **What happens:** "after a port change > the new server presents both certificates the same
  way" failed in 111 ms in the commit hook's full run. It passes alone. The error text was not
  kept.
- **Why (unconfirmed):** It takes a port from `freePort({ tcp: true })`, which releases it, and
  then `applyHttpsPortChange` binds that number. A test file running beside it can take the port
  in between, as in the DNS proxy tests fixed in a571c1a.
- **Fix:** Capture the error the next time it fails. If it is the port, let the test retry the
  change on another port when the bind is refused, or run the file on its own.

---

## Will not fix

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
- **Will not fix** (decided 2026-10-08, confirmed 2026-11-09). The fix rewrites every managed
  install's live dnsmasq.conf and cannot reach include-mode installs, for log noise only.
  Found reading prod's logs, 2026-10-06.
