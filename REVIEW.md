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

#### SYNC-SNAPSHOT-SIZE-01: A snapshot is built, sent and parsed as one string

**medium**, confirmed in the code (review of 63d815d, 2026-11-21). `server/src/sync/changes.js`
(`exportChanges`, `parseChanges`), `server/src/utils/sync-client.js` (`syncRequest`)

- **What happens:** A member's first copy, and every restart from a snapshot, holds the whole
  data of record in memory several times over: the export joins every row into one string, the
  client buffers the response, and the parse turns it back into one string. A data of record
  past Node's string limit (about 512 MB of NDJSON; `audit_log`, `ip_events`, `scan_results` and
  `dhcp_leases` are all in it) cannot be exported or applied at all, and a smaller one costs the
  controller and the member that much memory.
- **Why:** Phase 1 wrote the wire format as a Buffer in and a Buffer out.
- **Fix:** Stream it: the worker writes gzip to a file or a stream, the route pipes it, the
  client hands lines to the apply as they arrive, with the trailer hash checked before commit.

#### MEMBER-PWCHANGE-01: A user who must change their password cannot use a member

**low**, confirmed in the code (2026-11-21). `server/src/auth/middleware.js`
(`PASSWORD_CHANGE_PATHS`), `server/src/sync/write-gate.js`

- **What happens:** An account with `must_change_password` set signs in to a member and can do
  nothing: every request but the password change is refused by the sign-in middleware, and the
  password change is refused by the member write gate, with "This is a member of X. Make changes
  there." shown on the forced-password screen.
- **Why:** A member cannot write `users`.
- **Fix:** On a member, refuse the sign-in itself with "Set your password on X first.", or show
  that on the forced-password screen in place of the form.

#### SQLTIME-DUP-01: Four private copies of the SQL timestamp helper

**low**, confirmed in the code (2026-11-21). `server/src/models/session.js`,
`server/src/auth/tokens.js`, `server/src/routes/anomalies.js`, `server/src/utils/backup.js`

- **What happens:** Each file turns a time into SQLite's `YYYY-MM-DD HH:MM:SS` with its own
  function. `server/src/utils/sql-time.js` (`sqlTime`) is the shared one since phase 4 of the
  instances work.
- **Why:** Each was written before a shared helper existed.
- **Fix:** Import `sqlTime` in the four files, after checking each copy rounds and rejects bad
  input the same way.

#### ROGUE-V6-MEMBER-01: Rogue DHCPv6 detection can flag the member that serves DHCP

**medium**, confirmed in the code (2026-11-21). `server/src/utils/dhcpv6-probe.js`
(`classifyAdvertise`)

- **What happens:** With DHCP moved to a member, the controller's DHCPv6 probe hears that
  member's advertisement from its link-local address. `instanceAddressSet` holds no link-local
  addresses (they are dropped from `dns_addresses`) and the member's server DUID is not the
  controller's, so the advertisement is recorded as a rogue server. DHCPv4 is fine: the member's
  addresses are trusted.
- **Why:** An instance's link-local addresses and DHCPv6 DUID are not in the data of record.
- **Fix:** Have each instance report its DHCPv6 server DUID (and move the DUID with DHCP, see
  BACKLOG.md), and trust an advertisement carrying a known instance's DUID.

#### DHCP-READY-TERM-01: The "leases loaded" mark is a bare term number

**low**, read in the code, not reproduced (review of 425eadb, 2026-11-21).
`server/src/sync/dhcp-active.js` (`dhcp_ready_term`), `server/src/services/dhcp-follow.js`

- **What happens:** A member served DHCP at term 1. The controller is restored from a backup
  taken at term 0 and DHCP is moved to that member again before it has applied the restored
  state: the new term is 1 again, the member's mark already says 1, so it skips importing the
  leases and serves from whatever its server has on disk. Its next report replaces the
  controller's lease table with that set. The window is narrow.
- **Why:** The mark is not tied to the dataset the term belongs to.
- **Fix:** Store it as `dataset:term`, or delete it when a snapshot from a new dataset is applied
  and on join.

#### COLLECTED-EPOCH-DUP-01: A new upload epoch stores rows the controller already holds

**low**, reproduced (2026-11-21). `server/src/sync/collected-streams.js`,
`server/src/routes/sync-collected.js`

- **What happens:** After a member is restored or rolled back, the rows between its restored
  cursor and its head (about a minute of metrics) are uploaded again under a new epoch and stored
  a second time, so that minute counts double with All instances. A hostile member can repeat it
  at will.
- **Why:** The high-water mark is per epoch and nothing makes a member's row unique.
- **Fix:** A unique index on the member rows of each metrics table (`instance_id`, `ts` and the
  key column) with `INSERT OR IGNORE`.

#### LEASE-MAC-FORMS-01: A member's DHCPv4 lease with an unusual hardware address is dropped

**low**, read in the code (2026-11-21). `server/src/sync/lease-intake.js` (`cleanLease`)

- **What happens:** dnsmasq writes hardware types other than Ethernet as `tt-xx:xx:...`. The
  controller's own lease path passes that through to the lifecycle rules; a member's report drops
  the lease, so the controller treats a live lease as released. A DHCPv4 lease with no MAC at
  all is accepted, and would be written as the word `null` into a dnsmasq lease file at a later
  handover.
- **Why:** The validator accepts six colon-separated octets or nothing.
- **Fix:** Require a MAC on a DHCPv4 lease and accept the forms the adapters emit.

#### PROMOTE-NEWER-MEMBER-01: A member updated before its controller cannot be promoted

**medium**, read in the code (2026-11-22). `server/src/services/controller-promotion.js`
(`promoteSelfRefusal`), `server/src/sync/log.js` (`ensureSyncLog`)

- **What happens:** Update a member to a release with a migration, and the controller dies
  before the two are on the same version. The member's cursor was forgotten at boot (a migration
  ran) and it cannot take a snapshot from another schema, so `promote-self` answers
  `never_synced` for good, though the member holds a complete copy from before its update.
- **Why:** "Holds a complete copy" is read from the cursor, which a migration clears.
- **Fix:** Keep a separate mark that the copy was complete before the migration, and let a
  promotion go ahead on it with the last sync time shown. The upgrade guide says to update the
  controller first.

#### RESTORE-JOIN-RACE-01: A join during a restore is lost

**low**, read in the code (2026-11-22). `server/src/utils/backup.js`, `server/src/sync/restore.js`

- **What happens:** A member that joins between the moment a restore records the instance list
  and the process exit (under a second plus the file swap) is not in the restored list: it gets
  `unknown_member` and must join again. A join token made before a restore is gone after it.
- **Fix:** Refuse joins while a restore runs.

#### RESTORE-CARRYOVER-FAIL-01: A failed restore carry-over is logged and boot goes on

**low**, read in the code, no input known that triggers it (2026-11-22). `server/src/index.js`
(the `applyRestoreCarryover` call)

- **What happens:** If the first boot after a restore cannot write back the instance list and
  the epoch, it logs the error and carries on with the backup's. A lower epoch lets any member
  fence the controller. The next boot tries again.
- **Fix:** Start no sync-facing work (the sync routes, controller jobs) on a boot whose
  carry-over failed, and say so on the Instances page.

#### PROMOTE-LAST-CONTACT-01: The dead controller's row says "just now" after a forced promotion

**low**, seen on two hosts with 0.7.0-pre.1 (2026-11-22). `takeControllerRow` in
`server/src/services/controller-promotion.js`

- **What happens:** After Promote this instance, the old controller's row on the new
  controller shows Last contact "just now" though it has not answered. The takeover stamps
  `last_contact_at` so a later contact can be told from none (P6 fix), and the page shows the
  stamp as a contact.
- **Fix:** Keep the stamp in the takeover notice alone, or show "Not heard from since the
  takeover" while the notice for that instance is pending.

#### JOIN-SIGNIN-EARLY-01: The first-run join may open the sign-in page before the box is back

**low**, seen once, not reproduced (2026-11-22). `client/src/views/FirstRun.vue` (join step)

- **What happens:** After Join, a scripted sign-in sent the moment the sign-in page opened was
  refused: the service restarts five seconds after it exits (systemd `RestartSec`). A person
  typing a password is slower than that, so it may never show.
- **Fix:** Check that the join step waits for `/api/health` as the promotion paths do.

#### MEMBER-BACKUP-DELETE-01: A box that became a member cannot delete its old backup archives

**low**, read in the code (2026-11-22). `server/src/sync/write-gate.js`

- **What happens:** `DELETE /api/operations/backups/:id` on a member answers the member
  sentence. Archives it took as a controller stay until removed by hand; download works.
- **Fix:** Allow that route on a member: it is about this box's files.

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
