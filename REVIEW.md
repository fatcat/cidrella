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

---

#### WS-DHCP-AVAIL-01: With Show available off, the DHCP table pages and counts rows it hides

**medium**, confirmed in the browser and the code (2026-11-14).
`client/src/views/networks-workspace/NetworksWorkspace.vue:1675` (`filteredRows`) and `:2067`
(`rowTotal`)

- **What happens:** In a network's DHCP tab with Show available switched off, a page of 32 shows
  only the rows that are not available (4 on the dev estate) under "Showing 4 of 188", and the
  rest of the leased and reserved rows are spread thinly over the following pages. A search for
  an available pool address reads "Showing 0 of 1" over "No matching rows".
- **Why:** The server pages and counts the DHCP rows with available addresses included
  (`dhcp.total`); the request sends `showAvailable` for the Addresses read only. `filteredRows`
  then drops available rows on the client, after paging.
- **Fix:** Send `showAvailable` with the DHCP read and filter in the server query, as the
  Addresses table does, so the page and the total agree with what is shown. Drop the client
  filter for the IP tables.

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
