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

## Found testing a rollback on testerella (2026-11-06)

#### VT-SECOND-SCAN-01: a release published after another that UTC day may get no VirusTotal scan

**medium**, the failures are confirmed from the Actions history; the cause is inferred.
`.github/workflows/virustotal.yml:33`.

- **What happens:** On all three UTC days with more than one scan, the first passed and every later
  one failed: 2026-10-11 (5.7 h apart), 2026-10-22 (5 h), 2026-11-06 (22, 33 and 57 minutes after
  the first). Today's error is HTTP 429 a few seconds after the download; the older logs have
  expired. `v0.5.3-pre.2`, `v0.6.1-pre.2` and `v0.6.3-pre.3` to `pre.5` have no scan link. The
  failed step also skips the Pages rebuild, so a final release published after a pre-release that
  day would have no scan and a stale `/virustotal/` redirect, while the README badge says every
  release is scanned.
- **Why:** The action hides the response body, so `QuotaExceededError` and `TooManyRequestsError`
  look alike. The 5 h gaps rule out the 4 a minute limit, and a few scans are far from the reported
  500 a day, so this is a limit on the key not visible from here, or another user of it. Unconfirmed.
- **Fix:** Read the key's quota once to confirm. Then have a failed scan retry after 00:00 UTC, and
  let the Pages rebuild run whether or not the scan passed.

#### HARNESS-RESET-01: the test harness's wipe leaves the newer units running

**medium**, read from the code. `scripts/test-harness/run.sh:117` (`reset_host`).

- **What happens:** It stops only `cidrella`, `cidrella-dnsmasq` and `cidrella-anomaly`, then
  deletes `/etc/systemd/system/cidrella*.service`. On a host with `cidrella-dns-proxy`, Kea,
  PowerDNS or radvd running, those processes survive with their unit files gone and keep port 53
  and the DHCP ports, so the next scenario's install starts on a host that is not clean. It also
  leaves `/etc/polkit-1/rules.d/49-cidrella.rules`, the unit drop-in directories, the Kea, PowerDNS
  and radvd packages, and their apt lists.
- **Why:** The list predates the proxy process and the second stack.
- **Fix:** Stop and disable every `cidrella*` unit from `systemctl list-units`, including the
  templated Kea ones, remove `/etc/systemd/system/cidrella*` and the polkit rule, and purge those
  packages and lists.

## Found reading prod's address history (2026-11-06)

#### RETIRE-SLEEP-01: a laptop that sleeps past the offline hour is forgotten at every wake

**medium**, confirmed from prod's `ip_events` and the code.
`server/src/services/ip-lifecycle-service.js:40` (`OFFLINE_RETIREMENT_MS`),
`server/src/models/ip-address.js:595` (`retireLearnedMetadata`).

- **What happens:** A MacBook on 10.0.0.21 (`daniels-mbp`, scope lease 900 s) wakes about every
  four hours, takes a lease, sleeps, and the lease expires 15 minutes later. An hour after that
  (every gap measured is 60 or 61 minutes) the address is retired: hostname, MAC, first and last
  seen are cleared, and its DNS record goes, with a DNS regeneration queued. The next wake learns
  it all again. That is 27 retirements and about 7 history rows per cycle in 7 days, and 40 audit
  rows since 2026-10-11. While the laptop sleeps its name does not resolve and the address reads
  as empty, and `first_seen_at` never gets older than the last wake.
- **Why:** The window is a fixed hour from going offline, whatever the lease time or the device's
  habits. Any host that sleeps longer than lease time plus an hour cycles this way.
- **Fix:** Decide the window first. 9cad51c made it a fixed hour on purpose, and
  `tests/integration/security.test.js:697` refuses the old configurable setting as obsolete, though
  neither says why, so changing it reverses a decision. A lease longer than the sleep (about 4 h
  here) stops the cycle with no code change, since the address never goes offline for long enough.
  In code: a longer fixed window, or one that scales with the scope's lease time. Test: a lease
  that lapses, a wake inside and outside the window, IPv4 and IPv6 (SLAAC retirement shares the
  code path).

#### SETTING-RETENTION-01: a retired setting's row is still in prod's database

**low**, confirmed. No reference in `server/src`, `client/src`, `docs` or `scripts`; the settings
route refuses the key (`tests/integration/security.test.js:697`).

- **What happens:** Prod holds `offline_metadata_retention_days = 7`, which reads as a 7 day
  window, while addresses retire after one hour. Nothing acts on it.
- **Why:** 9cad51c replaced it with the fixed `OFFLINE_RETIREMENT_MS` and left stored rows behind.
- **Fix:** Delete the row in a migration.

#### SCOPE-LEGACY-BRANCH-01: the legacy branch in `v4Options` cannot run

**low**, confirmed in the code. `server/src/backends/shared/dhcp-scope-model.js:84`

- **What happens:** The `effective.options.length === 0` block never runs, so its fallbacks to
  the legacy `dns_servers`, `domain_name`, `ntp_servers` and `domain_search` columns are dead.
  It reads as though those columns reach a client from here. No client is affected.
- **Why:** `loadDhcpScopes` inner-joins `subnets`, so `subnet_cidr` is always set, and
  `resolveEffectiveScopeOptions` then always returns options 1 and 28 for IPv4.
- **Fix:** Delete the block. Its fallbacks for 15 and 119 repeat what the resolver already did.

#### TEST-STALE-MOCK-01: three test files mock modules that no longer exist

**low**, confirmed in the code. `server/tests/integration/routes/dns-zone-forward-unknown.test.js`,
`dns-target-names.test.js` and `dns-backup-resolver.test.js`, each `vi.mock` of
`src/utils/dnsmasq.js` or `src/utils/dhcp.js`.

- **What happens:** The mocks do nothing, so these tests run the real backend apply, and on a dev
  box that tries `systemctl restart cidrella-dnsmasq`. Under load a test can pass its 10 s limit:
  `dhcp-scope-defaults.test.js` had the same mocks and timed out in two of three full runs until
  it moved to `stubBackendApply`.
- **Why:** Those modules moved into `backends/` and the mocks were left behind.
- **Fix:** Replace them with `stubBackendApply` from `tests/helpers/fake-backends.js`, checking
  first whether a test relies on the real apply.

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
