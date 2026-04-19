# CIDRella Release Notes

This file is the canonical source of truth for what shipped in each release. Each section starts with a fenced YAML metadata block consumed by the build-time release-manifest generator (introduced in v0.4.12), followed by human prose. Newest releases first.

The `min_from` field in the YAML block declares the lowest version that may upgrade *directly* to this release. An empty value (`min_from: ""`) means any prior version may jump straight to this release.

---

## v0.4.15 — 2026-04-19

```yaml
min_from: ""
breaking: false
security: true
```

**Security release. All running v0.4.14 hosts should upgrade.** This release closes every CRITICAL and HIGH finding from the post-ship pentest of v0.4.14 (three security agents + code audit), plus every MEDIUM/LOW that had a cheap fix. No schema change.

The v0.4.14 release is also flagged on GitHub as deprecated in favor of this release; upgraders coming from v0.4.13 or earlier can hop straight to v0.4.15.

### Fixed — Critical
- **Unauthenticated process-crash DoS on `/api/auth/login`.** In v0.4.14, sending `{"username":"admin","password":{}}` (or any non-string shape for either field) triggered an unhandled promise rejection inside `bcrypt.compare`, which terminated the Node process. Systemd's 5 s restart loop meant one request every ~6 s kept the service 100 % offline. Fixed with strict `typeof` guards at the top of the login and change-password handlers, try/catch around every async code path, and a `process.on('unhandledRejection')` backstop so a future unprotected async handler can't kill the process either.
- **Authenticated dnsmasq config injection via DNS PTR record `name`.** The PTR name was written unescaped into `conf.d/zone-<id>.conf`, so a payload containing `\naddress=/evil.com/6.6.6.6\n` in the name field turned into an arbitrary dnsmasq directive after the next reload — hijacking DNS for any domain served by the proxy. Fixed with a strict PTR-name regex (`^[0-9]+(\.[0-9]+)*$`) at the route validator and belt-and-suspenders at the config writer.
- **Authenticated dnsmasq config injection via DHCP scope option values.** Symmetric problem on the DHCP side: `PUT /api/dhcp/scopes/:id` option values were interpolated raw into `dhcp-scope-N.conf`, letting any `dhcp:write` user push an attacker DNS server to every DHCP client via a newline-injected `dhcp-option=tag:scopeN,6,6.6.6.6`. Fixed with a shared `validateDnsmasqConfigValue()` sanitizer applied in both the route validator and the config writer. TXT record values get the same treatment (v0.4.14 also let a TXT value containing a newline break the zone file and kill DNS+DHCP via the dnsmasq restart loop).

### Fixed — High
- **Unauthenticated setup takeover on pre-first-login hosts.** `POST /api/setup` executed `DELETE FROM users; INSERT …` whenever the `installation_complete` setting wasn't the literal string `"true"`. On testerella that flag was `"false"` even though a seeded admin already existed, so any unauthenticated caller could swap in their own admin. `{"skip":true}` also silently flipped the flag unauthenticated. Fixed by marking the installation complete inside `ensureDefaults()` the moment any user row exists, re-checking the invariant inside the setup transaction (double-winner protection), and returning 409 Conflict when any user is present.
- **DNS + DHCP service DoS via TXT-record newline.** Already covered under dnsmasq injection above.
- **Authenticated DoS via `/api/subnets/calculate`.** Dividing `10.0.0.0/10` into `/30` returned ~60 MB of JSON in one response and hung the host for ~30 s. Now refuses any request that would produce more than 65 536 children with a 400 naming the limit. The child-count check runs before `calculateSubnets()`, so memory never spikes.
- **Type-confusion 5xx leaks on every write endpoint.** Sending `{"mac_address":123,...}` returned `{"error":"mac_address.toLowerCase is not a function"}`; `{"vlan_id":true}` returned a raw SQLite bind error. The global error handler echoed `err.message` verbatim for every 5xx. Fixed two ways in parallel: (1) `typeof` guards at the top of every write handler (subnets POST/PUT, DHCP scopes + reservations, DNS zones + records, blocklists source_url, settings) reject with clean 400s before the crash-bait string methods run, and (2) the global 5xx handler now returns a fixed `"Internal server error"` — full `err.message` still lands in the server log. 4xx errors still surface their validation messages, because those are what the UI shows to the user. JSON-parse errors are collapsed to `"Invalid JSON body"`.
- **`PUT /api/settings/:key` accepted any JSON shape.** Writing `{"value":{"a":1}}` for `dns_listen_port` persisted `"[object Object]"`, which would fail `parseInt()` at the next restart and bind to port 0. Fixed with a per-key schema (type + range/enum/regex for every editable setting). Invalid values return 400 with a diagnostic message. Bulk and single-key setters share the schema.
- **Authenticated write rate-limiter added.** v0.4.14 had only a login rate-limiter, so a compromised token could fill the DB at unlimited rate. A per-user/IP write limiter now caps POST/PUT/PATCH/DELETE across all `/api/*` routes at 300/min (5 req/s sustained) — plenty for human use, too slow to brick the server. Reads are intentionally unlimited.
- **SSRF in Pi-hole probe/fetch and blocklist source URLs.** Both paths let the server connect to any attacker-supplied URL without hostname-resolution + IP-range checks, enabling internal port scans and (for blocklist) response-body exfiltration. A shared `validateOutboundUrl()` helper now resolves the hostname, rejects loopback/link-local/RFC1918/CGNAT/AWS-metadata/TEST-NET ranges, and the blocklist fetch runs with `redirect: 'error'` so a redirect can't bypass the pre-check.
- **JSON 404 for unknown `/api/*` paths.** v0.4.14 fell through to the HTML SPA index, breaking any API client parsing JSON. A catch-all `/api` 404 handler now returns `{"error":"Not found"}`.

### Fixed — Medium / Low
- **`/api/auth/change-password` now rate-limited.** 10/15 min/IP with `skipSuccessfulRequests:true` — prevents brute-forcing the current password from a stolen token.
- **`/api/auth/login` limiter no longer locks out valid users.** `skipSuccessfulRequests:true` plus a raised burst of 20/15 min — a legitimate login after a mistyped attempt doesn't count against the lockout. Per-username lockouts were considered and rejected; they let an attacker lock the admin out of their own account.
- **Bcrypt dummy-hash on unknown username.** Login now always runs a bcrypt compare (against a randomized dummy hash) even when the username is unknown, so response-time enumeration (valid ~80 ms vs missing ~10 ms in v0.4.14) no longer works.
- **Unknown-user login attempts are audited.** Previously only wrong-password got an audit row; unknown-user attempts left no trace. Now logged as `login_failed` with `reason:unknown_user` and the truncated attempted username.
- **CNAME self-loop accepted.** v0.4.14 let you create a CNAME whose value resolved back to itself (dnsmasq SERVFAILs but it's still a foot-gun). Now rejected at validation.
- **Cross-forward-zone PTR overwrite.** Creating an A record whose IP already had a PTR pointing at a different forward zone silently rewrote the PTR. v0.4.15 refuses the write with a 409 and a `ptr_conflict` payload; callers can pass `force_ptr:true` to opt in explicitly.
- **Display-string validator on subnet name/description.** Reject `<` `>` and control characters to keep stored data benign even if a future UI surface ever uses `v-html`. No v-html exists today, but the pentest flagged the latent risk.
- **POST `/api/auth/logout`.** Bumps `users.updated_at` for the caller's user, which invalidates the caller's JWT via the existing iat-vs-updated_at check in the auth middleware. Not a true blacklist, but equivalent for a single-admin tool and doesn't grow unbounded.
- **MX/SRV/TTL integer range validation.** `{"priority":"high"}` or `{"ttl":"forever"}` now return 400 at the route — v0.4.14 persisted them unchecked and let them reach the config writer.
- **`PUT /api/dhcp/scopes/:id` / POST scope** now validates `domain_name` / `domain_search` / lease_time as strings with domain+escape checks.
- **`ipToLong()` type guard.** Defense-in-depth — throws `"expected string, got <type>"` if anything non-string slips through a route.

### Upgrade notes
- **Clean upgrade from any prior v0.4.x** — no schema change, no config change. Login rate limiter state resets on restart (as always), so an in-progress lockout from the v0.4.14 pentest window clears immediately.
- **v0.4.14 release page updated** to link to this security release. Users still on v0.4.13 or earlier can skip v0.4.14 entirely.
- **No breaking API changes.** The only observable behavior change for well-behaved clients is that malformed bodies now return 400 with a clearer message instead of the v0.4.14 500-with-stack-trace-ish response. API clients that relied on parsing the raw error text must migrate to looking at the HTTP status.

---

## v0.4.14 — 2026-04-19

```yaml
min_from: ""
breaking: false
security: false
```

A large feature + hardening release centered on the subnet / DNS / DHCP interaction layer, plus a UI design-system refresh and a scanner permissions fix. Schema migrates forward to **version 45** (migration `045_dns_zones_decouple_subnet.sql`). The upgrade is transparent — existing subnets keep their DNS zones via a new pointer-style linkage — but this is the largest single schema change since the original DNS/DHCP tables landed.

### New
- **UI design-system pass.** New CSS token set (`--p-*` aligned with PrimeVue Aura), per-view type scale, normalized status pills, shared `EmptyState` and `FooterBar` components, collapsible page `HeaderBar`, grouped System rail, tweaked Dashboard donut palette, and optional Range Map tab on the Analytics view. Several follow-on tweaks from real use: nav font bumped +30%, IP Management moved to a persistent left rail, and line-chart data-label clutter suppressed by default.
- **"Add DHCP Scope" right-click menu** on allocated-leaf subnets in IP Management → Networks. Opens the scope dialog pre-filled with the parent subnet's gateway / mask / domain, and suggested Start/End IPs derived from the subnet size via `dhcpRangeDefaults()`.
- **VLAN collision warnings.** Saving or configuring a subnet with a VLAN ID that is already in use on another subnet now returns a `vlan_warning` payload naming the peer subnets. The UI surfaces a warn toast ("VLAN 42 is already used on 10.0.3.0/24, 10.2.0.0/24"). Not an error — sharing a VLAN across CIDRs is valid but rare, and the warning makes accidental re-use visible.
- **Child subnets can have their own folder.** `subnets.folder_id` is now writable on children. `buildTree` promotes a child with its own folder to the root of that folder in the tree, so reorganization doesn't require detaching the child from its parent first. Drag-and-drop now works for child subnets too (the previous `:draggable="!subnet.parent_id"` gate was lifted).
- **Grid view readability.** Sub-pixel rounding artifacts fixed by replacing container `gap` with per-cell `box-shadow`. Every 16th column gets a thicker inset shadow for easier visual counting. DHCP reservations render dark blue and DNS-configured IPs pale green (distinct from user-locked violet, gateway orange, and system-range gray). Tooltip now includes a `Role: network` / `Role: broadcast` line for boundary cells (their Type stays `system`). Legend always shows every possible color plus any user-defined range types.
- **Multi-select bulk IP actions on the grid.** Right-click a rectangle of selected cells: **Unlock** (when any are user-locked), **Remove from Scope** (when the entire selection is inside one DHCP pool), and the existing Lock / Add to Scope entries. Middle-of-pool removal is refused client-side with a guidance toast ("can't split a DHCP pool") instead of hitting the server.
- **Safe-divide with lossy-IP cleanup.** Dividing a subnet that contains reservations, DNS A records, leases, or locked IPs that would fall outside the new child prefixes now opens a confirmation dialog listing each flagged IP with its reason (`network` / `broadcast` / `outside_selection`), carrier (reservation / IP record / DNS A), hostname, and MAC. "Divide Anyway" retries with `force_lossy: true`, and the server returns a `lossy_cleanup` summary that the client surfaces as a toast ("Removed 3 reservations, 2 DNS records, 1 lease"). `force` and `force_lossy` are separate gates so the two failure modes stay distinguishable.
- **Pool-shrink on divide.** When a child inherits a DHCP pool whose range includes the child's new gateway, the divide response carries a `pool_adjustments` entry and the client fires a warn toast per adjustment. The pool is resized to exclude the gateway rather than being deleted.
- **DNS-in-pool warn toast.** Saving a DNS A record whose IP is inside an active DHCP pool fires a warn toast ("DHCP may reassign this address — consider creating a reservation instead"). The record still saves.
- **Ranges table cleanup and Locked ranges.** Ranges now hides auto-generated system rows (Network / Broadcast / Gateway stay in the grid but not the table) and inserts contiguous `Locked` ranges for user-locked IPs so a span of locks shows as one row instead of N.
- **Three startup self-heals** in `server/src/index.js`:
  - `reconcileDnsOrphans` clears `ip_addresses.hostname` / `detection_source` on rows sourced from DNS that have no backing A record (cleans up artifacts from the record-rename bug fixed in this release).
  - Gateway-range repair rewrites Gateway-type `ranges.start_ip` rows that disagree with `subnets.gateway_address` (legacy fallout from an earlier `migrateConfigToChild` bug).
  - The pre-existing scope-options sweep stays.

### Changed
- **`dns_zones.subnet_id` dropped.** Migration 045 rebuilds `dns_zones` without the foreign key to `subnets`. Zones are now subnet-agnostic — the link is one-way via `subnets.domain_name` → `dns_zones.name`. Multiple subnets can share a zone; renaming a zone propagates the new name to every pointing subnet; deleting a zone clears `domain_name` on every pointing subnet. About 200 lines of compensating complexity (parent-zone migration on divide/merge, sibling zone reassignment on delete, the rename/adopt/detach state machine in subnet PUT) were removed as a result. Two HIGH architect-audit findings (partial-divide reverse-zone stranding, cross-sibling PTR lookup) evaporated structurally and need no further code.
- **PTR lookup by zone name, not subnet.** `findPtrLocation` in `utils/ip-sync.js` no longer filters by `subnet_id`. Reservations on any subnet now write PTRs into whichever reverse zone covers the IP, regardless of which subnet nominally owns the zone. This makes shared-zone and cross-subnet PTR flows work correctly.
- **Reservation POST guard.** `/api/dhcp/reservations` now rejects requests against subnets that are non-leaf or unallocated, closing a divide-then-insert race that could strand a reservation on an about-to-be-deleted parent.
- **Gateway-in-pool guarded on both sides.** PUT `/api/subnets/:id` (subnet side) and PUT `/api/dhcp/scopes/:id` (scope side) both reject an edit that would place the gateway inside an active DHCP pool, with a symmetric error message.
- **`ip_events.subnet_id` follows `ip_addresses.subnet_id`** on transfer during divide/merge, so historical event rows stay queryable under the current owning subnet.
- **DNS record PUT clears old `ip_addresses.hostname`** on name-only renames (previously only on value-only changes), plugging the orphan leak that `reconcileDnsOrphans` now sweeps on startup.
- **Scope / reservation dropdowns filter to allocated leaf subnets only.** Non-leaf and unallocated subnets no longer appear as pick targets in `ScopeDialog` or the DhcpPanel reservation dialog, matching the server-side guard.
- **MAC input cursor preservation.** The MAC formatter in `DhcpPanel` now counts hex characters before the caret and restores the cursor to the equivalent position after reformatting. Backspace mid-string no longer looks like "last char deleted."
- **"Delete Range" → "Delete DHCP Scope"** for scope-backed ranges. The range context menu relabels itself and routes the delete through `dhcpStore.deleteScope`, which atomically deletes the scope + options + range. Other range types keep the original "Delete Range" label and endpoint.
- **`afterCommit` single-flight regeneration.** Three regen hooks (`regenerate_dns`, `regenerate_dhcp`, `regenerate_dnsmasq_conf`) coalesce concurrent writes. `queueRegen(name)` is the out-of-request entry point used by the lease watcher. Callers that need the regen to complete synchronously (e.g. `applyInterfaceConfig` → `restartDnsmasq`) call the underlying function inline — the post-commit hooks fire in a microtask after `res.on('finish')` and are not a synchronous-completion primitive.

### Fixed
- **`arping` no longer runs under `sudo`.** The subnet scanner was shelling out to `sudo arping` despite `cidrella.service` having `AmbientCapabilities=CAP_NET_RAW` set — which broke scanning on any host with `NoNewPrivileges=yes` (everything from v0.4.8 onward). The scanner now invokes `arping` directly, relying on the inherited capability. Matches the sudo-removal pattern established in v0.4.11 for systemctl paths.
- **`PUT /api/subnets/:id` rejecting unchanged CIDR.** The guard was `if (cidr !== undefined)` which fired even when the body echoed the existing value — which the UI does on any subnet-edit submission. Now only rejects a *changed* CIDR. Dragging a subnet into a folder without editing anything else no longer errors.
- **Lossy-divide detector missing non-boundary carriers.** Previously only caught gateway/boundary IPs. Now also catches reservations, `ip_addresses` rows with real state, DNS A records, and `outside_selection` for partial divides where one or more children don't cover an existing record.
- **Stale gateway-range rows after child divides.** A previous version of `migrateConfigToChild` copied `parent.gateway_address` into children's Gateway-type `ranges` rows, leaving ranges pointing at IPs that weren't in the child's prefix. Now self-heals on startup.

### Upgrade notes
- **Schema migrates to version 45.** Migration is non-destructive — `subnets.domain_name` already held the linkage in a duplicated form; the migration just removes the `dns_zones.subnet_id` column. No user action required.
- **Backups from v0.4.14 carry `schema_version: 45`.** v0.4.13 and earlier will refuse a v0.4.14 backup during restore (per the newer-than-running refusal added in the resilient-update work).
- **Any direct SQL integrations against `dns_zones.subnet_id`** need to switch to joining via `subnets.domain_name = dns_zones.name`. CIDRella itself does not expose this column externally; the note is for anyone who was querying the DB directly.

---

## v0.4.13 — 2026-04-15

```yaml
min_from: ""
breaking: false
security: false
```

A defensive hotfix for three silent-failure modes that surfaced during real-world deployment of v0.4.12. None of these are regressions in v0.4.12 code — all three were latent gaps in how v0.4.11's polkit migration interacts with the upgrade path. None affected fresh installs. All three are fixed so that the class cannot recur.

### Fixed
- **`update.sh` now reconciles polkit state on every upgrade, and hard-fails if reconciliation fails.** v0.4.11 added a polkit dependency and set it up in `install.sh`, but never added the corresponding reconciliation to `update.sh`. Hosts that reached v0.4.11 via `cidrella-update` (not a fresh install) ended up with v0.4.11 code and systemd unit file but no polkit package, no `/etc/polkit-1/rules.d/49-cidrella.rules`, and no templated `/etc/systemd/system/cidrella-update@.service`. The first UI update attempt then failed with a systemd "Access denied" error. v0.4.13 adds a pre-switchover block to `update.sh` that: installs `polkitd` (or legacy `policykit-1`) if missing; refreshes the rule file from the shipped copy regardless of drift; ensures the polkit daemon is active (handles the Debian `polkit.service` / `polkitd.service` naming drift and the LXC `status=217/USER` NSS-cache race on first start); installs the templated worker unit if absent. Any failure in this block **aborts the update** with a diagnostic naming both package names, the exact recovery commands, and an explicit "your current version has not been modified" assurance. The block runs before the systemd unit-file install so a failure leaves the host's systemd state fully untouched.
- **`build-release.sh` now hard-fails the build if `package.json.version` has no matching `## vX.Y.Z` header in `RELEASE-NOTES.md`.** v0.4.12 was initially built from a RELEASE-NOTES.md that did not yet contain a v0.4.12 entry, so the signed releases.json manifest published with v0.4.12 listed v0.4.11 as the newest release. Hosts fetching the manifest would have seen "up to date" and silently missed v0.4.12. Caught during validation and fixed post-hoc with a manifest re-upload to the existing v0.4.12 release (tarball and signature unchanged, only the manifest assets). v0.4.13 adds a pre-preflight guard that runs before any expensive build work — a missing entry exits 1 with the exact file name, header format, and date to add.
- **`cidrella-update@.service` ExecStart no longer fails via systemd's variable expansion.** The inline `bash -c` wrapper that strips the timestamp suffix from `%i` used plain `$1` / `$instance` / `$version` references. systemd parses `$VARNAME` as its own environment-variable substitution before the string reaches bash — so systemd replaced those references with empty strings (env vars `1`, `instance`, `version` don't exist), and bash ran with `instance=""; version=""; exec update.sh --version ""`. update.sh's `--version` argument is optional and falls back to `releases/latest` when empty, which made this an accidental-success mode — v0.4.11 → v0.4.12 installed correctly only because `releases/latest` happened to be v0.4.12 at the moment. A release lag of one version would have silently installed the wrong thing. Fixed by escaping the dollar signs as `$$` so systemd passes them through to bash literally. Validated end-to-end by running `systemctl start cidrella-update@0.4.99_test.service` and verifying update.sh correctly tries to fetch `releases/tags/v0.4.99` (and fails at the network layer because that tag doesn't exist), proving the version arg is flowing through.

### Changed
- **`INSTALL-NATIVE.md` now documents the polkit requirement explicitly.** New package-table row, new prerequisites subsection explaining the sudo → polkit migration, full recovery procedure for stuck CLI-upgraded hosts, and an update to the "What the installer does" bullet list. The polkit requirement has been there since v0.4.11 but wasn't documented at the install-doc level — only inside individual commit messages and RELEASE-NOTES.md entries.

### Upgrade notes
- **If you're on a fresh-install v0.4.11 or v0.4.12 host**: UI update to v0.4.13 works normally.
- **If you're on a CLI-upgraded v0.4.11 host** (upgraded via `cidrella-update` from v0.4.10 or earlier): you still need to run the manual polkit recovery procedure documented in `INSTALL-NATIVE.md` (or the v0.4.12 Known issues section of this file) **before** your first UI update. v0.4.13's improved reconciliation block only helps on the *next* upgrade *after* you're already running v0.4.13 — you cannot use the broken v0.4.11 UI updater to install the v0.4.13 update that fixes the updater. Alternative: run `cidrella-update` from a root shell; it bypasses the polkit requirement and works on every v0.4.11+ host regardless of how it got there.
- **If you're on v0.4.12**: the update.sh shipping in v0.4.12 still lacks the polkit reconciliation block, but v0.4.12 hosts that upgraded cleanly already have polkit installed — the new block will be a no-op on the v0.4.12 → v0.4.13 hop. The reconciliation only matters for hosts that were missing state when they hit v0.4.13.

---

## v0.4.12 — 2026-04-15

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Skip-upgrade foundation.** Each release now ships a signed `releases.json` manifest as a GitHub release asset alongside the tarball. The manifest is the machine-readable view of this file, parsed from the YAML metadata blocks under each section. A new server-side fetcher downloads, signature-verifies, and caches the manifest; `GET /api/version` uses it to compute the highest reachable target from the currently-running version. Skip-upgrade comes alive starting here — future releases that declare a `min_from` will force users through the named intermediate instead of silently allowing a jump that would skip a load-bearing migration.
- **`min_from` gate in `update.sh`.** After the post-minisign `RELEASE.json` read, a new gate checks the target release's `min_from` field against the running version. If the gate fires, the update refuses with a diagnostic-sufficient error naming both versions and the required intermediate, wipes the target slot so the refused payload doesn't sit on disk, and emits a `preflight fail reason=min_from_unmet` event. Backward compatible: pre-v0.4.12 tarballs without the field pass through unchanged.
- **Multi-hop chain display in the Updates panel (read-only).** When the manifest indicates the user is more than one release behind the latest and the latest requires going through an intermediate, the Updates panel renders the full chain path (e.g. `v0.4.9 → v0.5.0 → v0.5.5`), labels the Install button "Install Step 1 of N", and hints that the user should return after each completion to continue the chain manually. No auto-chain, no Stop button, no cross-restart state machine — deferred to v0.5.x per agent-team consensus. The ~10 lines of state-machine complexity saved here are not worth the partial-success failure modes they'd introduce.
- **`manifestAvailable` field in `GET /api/version`.** When the signed manifest can't be fetched or verified, the server falls back to the legacy GitHub API one-hop check and surfaces `manifestAvailable: false` in the response. The Updates panel shows a "skip-upgrade information unavailable" note under the Install button so the degradation is visible. The architect pre-implementation review flagged silent fallback as a repeat of exactly the class of bug v0.4.11 fixed — this closes that loop.
- **`build-release.sh` manifest step.** Step 5.5 lints `RELEASE-NOTES.md` (hard-fails on any issue), generates `dist/releases.json`, signs it with the primary minisign key, and post-sign verifies against the committed `scripts/cidrella.pub`. Step 7 uploads the manifest and signature as release assets alongside the tarball.
- **`RELEASE.json` inside each tarball gains a `min_from` field.** Authoritative after signature verification. update.sh uses it for the min_from gate and falls back to "no gate" when the field is absent.
- **New harness scenarios.** `skip-upgrade` (CLI cidrella-update end-to-end on bundled-Node hosts — regression guard for the v0.4.11 bare-`node` preflight fix), `min-from-blocked` (unit-style reproduction of the gate logic against five synthetic RELEASE.json fixtures), `manifest-fallback` (forces signature verification failure via wrong-pubkey swap and asserts the API surfaces `manifestAvailable: false`).
- **Defense-in-depth "Reset update state" affordance.** The Updates panel's Version card has a new always-visible three-dot button that opens a confirmation and clears the in-progress update-status record. Works regardless of the current state — insurance against any future stuck-state bug the reaper doesn't catch.

### Fixed
- **Reaper error message is generic.** v0.4.11's stale-status reaper baked the NNP-trap-specific diagnostic into every future reaped record, which would mislead users hitting unrelated causes. Now says "update worker did not report progress within the grace window" with a `reason_code: worker_silent` field, and the historical NNP context lives here in RELEASE-NOTES.md where it belongs.

### Known issues
- **Upgrades from v0.4.11 via `update.sh` leave polkit unconfigured on hosts installed before v0.4.11.** The v0.4.11 polkit setup (package install + rule drop + daemon start) lives in `install.sh`, not `update.sh`. Hosts that reached v0.4.11 via `cidrella-update` (not a fresh install) therefore have the new Node code and systemd unit but no polkit daemon and no rule file — the next UI update attempt fails with "Access denied" from systemctl. Recovery: install polkit manually (`apt-get install polkitd`), copy `/opt/cidrella/scripts/polkit/49-cidrella.rules` to `/etc/polkit-1/rules.d/`, start the daemon, clear `/var/lib/cidrella/update-status.json`, retry the update. v0.4.13 adds a polkit reconciliation block to `update.sh` that hard-fails the update with a diagnostic if polkit can't be installed or started — prevents a silent broken-updater handoff from recurring.
- **Manifest shipped incomplete.** The initial v0.4.12 release was built from a RELEASE-NOTES.md that did not yet contain a v0.4.12 entry, so the signed releases.json manifest listed v0.4.11 as the latest version. Hosts fetching the manifest would see "up to date" and not offer v0.4.12 as an available update. Fixed post-hoc by regenerating the manifest with the v0.4.12 entry and re-uploading `releases.json` + `releases.json.minisig` to the v0.4.12 release (tarball and tarball signature unchanged). The v0.4.13 release adds a build-time guard that hard-fails the build if `package.json.version` doesn't have a matching entry in RELEASE-NOTES.md, so this class of bug can't recur.

---

## v0.4.11 — 2026-04-15

```yaml
min_from: ""
breaking: false
security: true
```

### New
- **Polkit-gated systemctl path** replaces sudo for all in-app updates and dnsmasq reload/restart calls from the cidrella server. New templated worker unit `cidrella-update@.service` is started via D-Bus, authorized by `/etc/polkit-1/rules.d/49-cidrella.rules`, and runs as root with no inherited sandbox. The cidrella service account never invokes sudo for these paths anymore.
- **Stale update-status auto-recovery.** A new reaper in the server detects `update-status.json` records that claim an in-progress update but have no live worker behind them. After a 180-second grace, the record is rewritten as `failed` with a diagnostic error, exposing the UI's Dismiss button and unblocking the user. The reaper runs both lazily (on every status read) and eagerly (on server boot).
- **Polkit is now a hard install dependency.** `scripts/install.sh` installs `polkitd` (modern Debian/Ubuntu) or `policykit-1` (older), probes `pkaction --version`, and verifies the daemon is active. Failures abort the install with a diagnostic.
- **Update worker unit instances are uniquely tagged.** The systemd template instance name is `cidrella-update@VERSION_EPOCH.service`, where `EPOCH` is the wall-clock seconds at start time. Retries of the same target version no longer collide on a previously-failed instance's state.
- **`RELEASE-NOTES.md` is now the canonical release-info source.** Future build-time tooling will parse this file's YAML metadata blocks to generate a signed `releases.json` manifest (planned v0.4.12).

### Fixed
- **UI updater stuck at "Starting update..." on v0.4.8/v0.4.9 hosts.** The v0.4.8 systemd hardening on `cidrella.service` enabled seven directives (`RestrictSUIDSGID`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`, `PrivateDevices`, `LockPersonality`) that each *implicitly* set `NoNewPrivileges=yes` per `systemd.exec(5)`. The author left the explicit `NoNewPrivileges=true` commented out, knowing it would break sudo's setuid escalation, but did not catch the implicit set. Every `sudo` call from the cidrella process — including the UI updater's `sudo systemd-run` — silently failed with `sudo: unable to change to root gid: Operation not permitted`. Because the API spawned the child with `stdio: 'ignore'`, the failure was invisible: the API wrote the initial `state: starting` row to `update-status.json`, returned HTTP 202, and the panel sat there waiting for a worker that didn't exist.
- **DNS reload silently failing after blocklist or config changes.** Same root cause as above — the `cidrella-dnsmasq-hup` wrapper required sudo, which doesn't work under NoNewPrivileges. dnsmasq kept serving stale config until something forced a real restart. Replaced with `systemctl reload cidrella-dnsmasq` (gated by polkit), with `cidrella-dnsmasq.service` now exposing `ExecReload=/bin/kill -HUP $MAINPID`.
- **CLI updater preflight failing as "syntax errors" on bundled-Node-only hosts.** The v0.4.3-v0.4.10 `update.sh` preflight ran `node --check` with a bare `node`, not the resolved bundled binary. On hosts installed from a v0.4.7+ tarball with no system Node (the supported config since the bundled-runtime migration), the bare invocation hit command-not-found, and the stderr was swallowed by `2>/dev/null`, which the script then reported as "syntax errors". Result: CLI updates appeared broken with a misleading error on every bundled-Node-only host. Fixed by routing the preflight syntax check through the existing `resolve_node` helper (added in v0.4.3 but never wired into this callsite). Diagnostic output is now captured and surfaced on failure instead of being discarded.
- **Update worker error reporting.** The install handler in `server/src/routes/version.js` no longer uses `stdio: 'ignore'`. Spawn errors are captured from stderr and written into `update-status.json` as `state: failed` with the actual error string. Silent failure mode for the spawn is gone.

### Security
- The polkit migration is a defense-in-depth improvement: the cidrella service account no longer needs setuid escalation for any system-management operation. The only remaining sudo entry in `/etc/sudoers.d/cidrella` is for `arping` (used by the network scanner). Slated for removal in a follow-up via setcap on the arping binary or a Node raw-socket replacement.
- The hardening directives on `cidrella.service` are **unchanged** — the sandbox was never the problem; the use of sudo from inside it was. The implicit-NNP behavior is now acknowledged in the unit file's comment block.

### Upgrade notes
- Hosts on **v0.4.7 or earlier** are unaffected by the UI updater regression and may upgrade normally via either the UI updater or `cidrella-update`.
- Hosts on **v0.4.8 or v0.4.9** are blocked from the UI updater by the regression itself. **The CLI updater is also unreliable on these hosts because of the bare-`node` preflight bug** (see Recovery, below). The only universally reliable recovery is the manual systemctl-edit procedure.
- Hosts on **v0.4.10** can use either path: UI works (v0.4.10 introduced no new break), or `cidrella-update` works *if* the host has system Node installed. On bundled-Node-only v0.4.10 hosts, CLI still fails until v0.4.11's preflight fix lands. UI is the recommended path from v0.4.10.

### Recovery from v0.4.8 / v0.4.9 (manual systemctl-edit procedure)

You must do this from a root shell on the host. SSH in as root, or `sudo -i`.

#### Step 1 — Stop the cidrella server
```bash
systemctl stop cidrella.service
```
DNS and DHCP keep running because `cidrella-dnsmasq.service` is a separate unit and is not affected.

#### Step 2 — Override the breaking directives
```bash
systemctl edit cidrella.service
```
Paste this into the override editor:
```ini
[Service]
# Temporary override — disables the v0.4.8 hardening directives that
# implicitly set NoNewPrivileges=yes and break sudo escalation.
# v0.4.11 replaces sudo with polkit-gated systemctl, after which this
# override should be REMOVED with `systemctl revert cidrella.service`.
RestrictSUIDSGID=false
ProtectKernelTunables=false
ProtectKernelModules=false
ProtectKernelLogs=false
ProtectClock=false
PrivateDevices=false
LockPersonality=false
```
Save and exit, then:
```bash
systemctl daemon-reload
```

#### Step 3 — Clear the stuck update status
```bash
rm -f /var/lib/cidrella/update-status.json
```

#### Step 4 — Start cidrella and run the UI update
```bash
systemctl start cidrella.service
```
Wait ~10 seconds, then load the web UI, navigate to **System → Updates**, click **Check Now** if needed, and click **Install Update**. The update should proceed normally through every phase.

#### Step 5 — Revert the override after the update completes
v0.4.11's `cidrella.service` no longer needs sudo for any UI-triggered action, so the original hardening can come back unchanged.
```bash
systemctl revert cidrella.service
systemctl restart cidrella.service
```
Confirm health:
```bash
systemctl status cidrella.service
curl -sk https://localhost:8443/api/health/deep | head
```

### Why CLI recovery (`cidrella-update`) is *not* the recommended path
Two separate bugs interact:
1. The cidrella service account can't sudo from inside the hardened cidrella.service — but `cidrella-update` is invoked from a root shell, so sudo escalation is not blocked. Good so far.
2. **However**, v0.4.9's `update.sh` preflight calls `node --check` with a bare `node` binary, expecting system Node to be present. On hosts installed from the bundled-Node v0.4.7+ tarball with no system Node, that command is "not found" and the script misreports it as a syntax error in `server/src/index.js`. The CLI update appears to fail for an unrelated reason.

If your host *does* have system Node installed (e.g., you installed it manually for development, or you upgraded from a pre-v0.4.7 install), CLI recovery may work. If you're on a clean bundled-Node-only install, CLI recovery does not work on v0.4.8 / v0.4.9 — use the systemctl-edit procedure above.

This bare-`node` bug is fixed in v0.4.11; from v0.4.11 forward, CLI updates are reliable on bundled-Node-only hosts.

---

## v0.4.10 — 2026-04-14

```yaml
min_from: ""
breaking: false
security: false
```

### Known issues
**The in-app UI updater is broken on this release** due to systemd hardening that implicitly sets `NoNewPrivileges=yes`, which blocks sudo escalation from inside the cidrella service. Same root cause as v0.4.8 and v0.4.9. **Install v0.4.11 or later instead.** If you're already on v0.4.10, see the v0.4.11 entry's *Recovery* section.

### New
- **Integration test harness** at `scripts/test-harness/`. SSH-driven scenario runner with three seed scenarios (fresh-install with 32 assertions, secret-file-perms with 12, post-install-hook with 8). Agent-facing `manifest.json` with `catches`/`does_not_catch` fields so review agents can discover and use the harness without reading scenario source. JSON result emission with `schema_version: 1`. Dev-only — excluded from release tarballs via `.buildignore`.
- Validator agent (`~/.claude/agents/validator.md` §8) updated to discover and use the harness before hand-rolling validation SSH sessions.

### Fixed
- **OOM kills on small-RAM installs** (1GB LXCs were getting killed by the kernel OOM killer during DuckDB startup and during heavy log ingestion). DuckDB memory limits explicit. Logs subsystem batches and back-pressures.
- **Rotation hardening (security findings).** `scripts/lib/rotation.sh` `load_key_state` replaced `eval "$parsed"` with newline-separated values + `IFS= read -r`, closing a shell-injection vector from a crafted `.key-state.json`. Pubkey base64 charset + length bound check at parse time. `fetch_rotation_announcements` curl calls hardened with `--proto '=https' --proto-redir '=https'` so a crafted `browser_download_url` can't smuggle `file://` schemes. The undocumented `revoked_pubkey_strict_check` env bypass was removed; the check is now unconditional.
- **`update.sh` bootstrap path resolution.** `readlink -f "$0"` now runs *before* the `cd /` anchor. The prior order caused `./update.sh` invocations to resolve `$0` relative to `/`, producing `//scripts/lib` as the lib path. Added a fallback to `$INSTALL_LINK/scripts/lib` and a diagnostic that prints `$0`, the resolved path, and `$INSTALL_LINK`.
- **`update.sh` canonical-command nudge.** Direct `./update.sh` invocations now print a tip suggesting `cidrella-update` (the wrapper). Suppressed under `--from-api`.
- **Test harness `capture_command`** rewritten without the `head -c` pipefail+SIGPIPE race that silently mis-reported >4KB successful commands as `<command-failed>`.
- **`scripts/post-install.sh` header note** documenting the `set -eu` conflict with the "warn and continue" contract for future maintainers.

### Upgrade notes
- v0.4.10 is downloadable but contains the v0.4.8/v0.4.9 UI updater regression. Treat as deprecated; install v0.4.11+ instead.

---

## v0.4.9 — 2026-04-13

```yaml
min_from: ""
breaking: false
security: true
```

### Known issues
**The in-app UI updater is broken on this release** (same root cause as v0.4.8). See the v0.4.11 entry for the recovery procedure.

### New
- **Post-install hook convention.** `scripts/post-install.sh` runs after every successful install or update. Receives a structured environment (`CIDRELLA_HOOK_REASON`, `CIDRELLA_HOOK_FROM_VERSION`, `CIDRELLA_HOOK_TO_VERSION`) and follows a "warn and continue" contract — the hook does not gate the install.
- **Break-glass key rotation consumption code.** `scripts/lib/rotation.sh` consumes signed `cidrella-rotation-N.json` announcements and applies them via persisted state in `/var/lib/cidrella/.key-state.json`. Sequence-number replay protection. `not_before`/`not_after` window enforcement. Update flow consults the rotation state before fetching the next release.
- **CLI password reset audit trail.** `scripts/cidrella-reset-password` writes an `audit_log` row, populates `users.password_reset_by`, and the affected user sees a banner on next login if the reset was unauthorized.
- **Backup/restore version safety + pre-restore snapshots.** Every backup carries a manifest with `version` and `schema_version`. Restore refuses newer-than-running backups. Restore takes a `pre-restore` snapshot to `/var/lib/cidrella/snapshots/pre-restore/` before touching the live DB so a bad restore is recoverable.
- **Secret file permission tightening.** DB at 600, server.key at 600, certs/backups/anomaly directories at 700, dnsmasq state at 755 (intentional — dnsmasq drops privileges).

---

## v0.4.8 — 2026-04-12

```yaml
min_from: ""
breaking: false
security: true
```

### Known issues
**This release introduced the UI updater regression.** The systemd hardening sweep enabled directives that implicitly set `NoNewPrivileges=yes`, which broke sudo escalation from inside the cidrella service and silently disabled the in-app updater. See the v0.4.11 entry for the recovery procedure.

### New
- **Comprehensive systemd hardening sweep** on all three units (`cidrella.service`, `cidrella-dnsmasq.service`, `cidrella-anomaly.service`). `ProtectSystem=strict`, `PrivateDevices`, `ProtectKernel*`, `LockPersonality`, `RestrictSUIDSGID`, `RestrictNamespaces`, `RemoveIPC`, narrow `CapabilityBoundingSet`. Largest single attack-surface reduction the project has shipped.
- **Runtime bundle size reduction** — stripped unused tooling from the bundled Node runtime directory. ~15% smaller release tarball.
- **Break-glass minisign pubkey embedded** in `install.sh` from this release forward. Provides a recovery path if the primary release-signing key is rotated or compromised.
- **`scripts/lib/tighten-secrets.sh`** extracted for reuse between install and update flows. Schema checks hardened.
- **Build-time pubkey consistency checks.** Build script verifies that the embedded primary and break-glass pubkeys match the keys actually used to sign the release.

---

## v0.4.7 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Bundled Node runtime + bcryptjs (Phase 2 of the bulletproof update train).** Release tarballs now include their own pinned Node binary at `runtime/node/bin/node`. systemd `ExecStart` uses the bundled path, eliminating the Node ABI mismatch failure class. `bcrypt` (native module) was replaced with `bcryptjs` (pure JS) to reduce the bundled native-module surface.
- **Setcap is re-applied between extract and preflight** so the bundled Node has `cap_net_raw,cap_net_bind_service+ep` from the moment it boots, not after switchover.
- **`UPGRADING-0.4.6-to-0.4.7.md` hot-patch runbook** for users who needed to recover from the bundled-Node migration mid-flight.

### Upgrade notes
- This release introduces bundled Node. After upgrading, `node` may no longer be installed system-wide and is not required.

---

## v0.4.6 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: true
```

### New
- `.buildignore` system for excluding files from release tarballs.
- Sudoers tightening: replaced overly-broad `kill -HUP [0-9]*` rule with a dedicated `cidrella-dnsmasq-hup` wrapper that verifies the target via `/proc/<pid>/comm`. Removed the unused `nmap` rule entirely.
- `/api-browser` gated in production builds.
- Dev secret rotation script.

### Fixed
- `cd /` anchor in `update.sh`.
- `tee` log capture in install/update flows.
- Validator-agent release-hygiene checklist.

---

## v0.4.5 — 2026-04-10

```yaml
min_from: ""
breaking: false
security: false
```

### Fixed
- UI `--scope` invocation fix.
- Anomaly staleness reporting.
- `update.sh` errors are now diagnostic-sufficient on their own (no more "see line 350" type messages).
- Install-start event emission.
- Anomaly daemon restart on update.
- `backup.js` now includes `analytics.duckdb` and the anomaly model files.

---

## v0.4.4 — 2026-04-09

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Shared bash library** at `scripts/lib/`: `verify.sh`, `slots.sh`, `preflight.sh`, `systemd-install.sh`, `log.sh`. Sourced by install.sh, update.sh, and rollback.sh — single implementation per concern.
- **Structured JSONL events** at `/var/lib/cidrella/events.jsonl` from every shell script. Append-only. Format: `{ts, phase, event, data}`. CI and the test harness assert on structured events instead of string-matching log output.

---

## v0.4.3 — 2026-04-08

```yaml
min_from: ""
breaking: false
security: false
```

### New
- **Bundled Node runtime plumbing (Phase 0 of the bulletproof update train).** `update.sh` and rollback.sh learn to prefer `$INSTALL_LINK/runtime/node/bin/node` if present, fallback `/usr/bin/node`. Embedded `RELEASE.json` inside the tarball with `version`, `built_at`, `commit_sha`, `bundled_node_version`. Verified post-minisign so the downgrade guard runs against signed data.
- The downgrade guard now uses the verified `RELEASE.json` version, not the GitHub API's `tag_name`.

---

## v0.4.2 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- A/B slot layout shipped to general availability. `/opt/cidrella` is a symlink to `/opt/cidrella-a` or `/opt/cidrella-b`. Updates extract to the inactive slot, preflight on port 18443 with isolated `/tmp/cidrella-preflight` data dir, atomic symlink swap, auto-rollback on health failure.
- Pre-update DB snapshot to `/var/lib/cidrella/snapshots/pre-update/`. SQLite WAL-checkpointed, DuckDB analytics included.
- Schema version compatibility check refuses startup on new-DB-old-code (prevents unsafe rollback corruption).
- Backup manifest with `version` + `schema_version` gating restore.

---

## v0.4.1 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Installation documentation overhaul with security guidance.

---

## v0.4.0 — 2026-04-11

```yaml
min_from: ""
breaking: false
security: true
```

### New
- Security hardening pass.
- Code quality and DRY consolidation.
- Initial release of the v0.4.x train.

---

## v0.3.0 — 2026-03-15

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Package and dependency updates.

---

## v0.2.0 — 2026-03-12

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Metrics performance improvements.

---

## v0.1.0 — 2026-03-10

```yaml
min_from: ""
breaking: false
security: false
```

### New
- Initial public release.
- Version management and update checking system.
