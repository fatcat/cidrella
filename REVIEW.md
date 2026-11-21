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
