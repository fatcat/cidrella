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

#### TEST-FLAKE-PROMOTION-01: Promotion tests time out now and then under the full suite

**low**, test only, seen 2026-11-23. `server/tests/integration/controller-promotion-findings.test.js`,
`server/tests/helpers/instance-estate.js:139` (`unplug`)

- **What happens:** In two of four full runs from the commit hook, one test there hit its timeout:
  "is waited for: a member naming the handover's target does not fence the old controller"
  (30 s) and "sends everything to a member that moves between two controllers of one epoch"
  (60 s). The file passes alone, 3 of 3, and 6 of 6 copies run at once; two plain
  `npm run test:server` runs did not reproduce it. The same runs took 110 to 154 s against 72 s
  earlier in the day.
- **Why (unconfirmed):** `unplug` resolves on `server.close()`, which waits for every open
  connection to end. A request still in flight to the instance being unplugged would hold it to
  the timeout.
- **Fix:** Make `unplug` call `server.closeAllConnections()` after `close()`, then check that the
  file still passes and the timeouts stop.

#### TEST-FLAKE-BACKUP-LOOP-01: The backup event-loop check fails on a busy machine

**low**, test only, seen 2026-11-23. `server/tests/integration/backup-event-loop.test.js:56`

- **What happens:** The worst event-loop gap during a backup is checked against 200 ms. It
  measured 296 ms in two full runs on a loaded machine, and passes alone.
- **Why:** It measures wall time, and the rest of the suite runs beside it.
- **Fix:** Run the file on its own (a separate vitest project or `--no-file-parallelism` for it),
  or raise the limit with a note on what it still catches.

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
