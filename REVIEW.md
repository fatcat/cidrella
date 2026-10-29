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
- **Related:** BACKLOG.md, Process isolation and event-loop blocking, item 1 lists the backup's
  tar among the synchronous child processes; this entry is that bullet, measured. Async `spawn`
  alone does not fix it, since the vacuums are database work, not a child process. Moving the
  DNS proxy into its own service (item 2) would keep DNS answering through it either way.

#### BLOCKLIST-STATS-STALL-01: Opening the blocklist stats stops DNS for up to 3 s

**medium**, confirmed on prod (0.6.1 and 0.6.2-pre.1). Deferred to 0.6.3.
`server/src/routes/blocklists.js:200` (`GET /api/blocklists/stats`).

- **What happens:** The request took 1.1 s on 10-25 16:36:59, 3.0 s on 10-26 10:03:40 and 3.1 s
  on 10-27 10:31:09 UTC. `pdns.log` holds no query in any of those windows (about 40, 4 and 5
  would be usual), and the analytics and metrics requests sent with it finished within a second
  of it, queued behind it.
- **Why:** The route runs `COUNT(DISTINCT bd.domain)` over `blocklist_domains` joined to the
  enabled categories, synchronously on the main thread the DNS proxy shares. On prod that is a
  scan of 3.6 million rows every time the stats load.
- **Fix:** Count the distinct enabled domains once per change, in `refreshAllEnabled` and the
  scheduler after a refresh and when a category is switched on or off, store the number (a
  setting, or a column read with the categories), and have the route read it. The search query
  in the same file (`:505`, unanchored `LIKE`) scans the same table; its comment measures it at
  about 0.1 s, so it is not part of this.
- **Related:** BACKLOG.md, Process isolation and event-loop blocking: its "looked at and fine"
  note covers the blocklist refresh, not these reads. Moving the DNS proxy into its own service
  (item 2) would keep DNS answering through it.

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
