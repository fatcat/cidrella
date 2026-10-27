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

## Found soaking 0.6.2-pre.2 on prod (2026-10-27)

#### BACKUP-STALL-01: DNS stops answering while a backup runs

**medium**, confirmed on prod (0.6.2-pre.2). Deferred to 0.6.3. `server/src/utils/backup.js:93`
(`createBackup`: `writeBackupDatabase` at :167, `spawnSync('tar', ...)` at :177), called by
`POST /api/operations/backup` (`server/src/routes/operations.js:179`) and the scheduled backup
(`backup.js:1214`).

- **What happens:** A manual backup at 11:48:48 took 13.3 s, and `pdns.log` shows no query from
  11:48:48 to 11:49:01, then a burst of 10 when the request returned. For those 13 s the DNS
  proxy answered nothing. A scheduled backup does the same.
- **Why:** Every step of a backup is synchronous on the main thread, which the DNS proxy shares:
  `VACUUM INTO` and the `VACUUM` of the copy (better-sqlite3), then `spawnSync` for tar. Before
  0.6.2 the tar step alone blocked for the whole archive of a 337 MB database; how the 13 s
  splits between the vacuums and tar was not measured.
- **Fix:** Build the database copy in a worker thread with its own connection (WAL lets it read
  while the main connection writes), run tar with async `spawn`, and make `createBackup` async,
  awaited by the route and the scheduler. Test: hold a backup in progress and check the event
  loop keeps turning (a timer fires on time). The pre-restore snapshot's `spawnSync` tar
  (`backup.js:568`, `:582`) blocks the same way, but a restore ends in a restart anyway.

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
