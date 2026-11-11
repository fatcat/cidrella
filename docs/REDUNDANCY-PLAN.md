# Controller and members: redundant CIDRella instances

Status: design accepted 2026-11-11, target 0.7.0. Not started. This document is the plan of
record; `docs/ARCHITECTURE.md` gets its own section when phase 0 lands.

## Context

CIDRella runs as one instance. An admin who wants a second DNS server today installs another
copy and restores a backup onto it, which drifts the moment either side changes. Redundancy is
built in instead, and the mechanism is used even on a single box so it cannot rot:

- Every install is a **member**: it runs the DNS and DHCP daemons and the DNS proxy, driven
  from a local database.
- Exactly one install is also the **controller**: it owns every write to the data of record
  and the full UI. A single box is controller and member in one process on one database.
- Other members pair with the controller, hold a synced read-only copy of its data, serve DNS
  (and stand by for DHCP) from it, and show a mostly read-only UI. They keep serving when the
  controller is away.
- An admin can promote a member to controller. No election.
- Analytics is aggregated on the controller, with a per-instance filter.

Decided: aggregated analytics, promotion included, the names Controller and
Member, target 0.7.0. The branch `dev/0.7.0` is cut from the released 0.6.4 commit when the
first code is ready; `min_from` is 0.6.4.

Wording: "role" already means three things in the code (user role, deployment role, DNS/DHCP
role switches), so the code calls this the **instance mode** (`controller` or `member`), under
`server/src/sync/`. An "instance" is any install.

## Design

### 1. Data classes (one registry)

`server/src/sync/registry.js` classifies every table and every settings key. A guard test
(modeled on `tests/unit/services/audit-coverage.test.js`) fails when a table in `sqlite_master`
or a key in `DEFAULTS` is unclassified, or an entry is stale.

- **estate**: replicated from the controller to every member, so any member can be promoted
  without loss. All configuration tables, `ip_addresses` (whole row), `dhcp_leases`,
  `dns_records`, fingerprints, rogue events, scans and results, `ip_events`,
  `ip_range_events`, `audit_log`, `users`, `user_backup_codes`, `api_tokens`, anomaly
  allowlist and scores, estate settings keys, the config columns of `blocklist_categories`,
  and a new `sync_instances`.
- **host**: never leaves the box. `sessions`, `backups`, `schema_version`,
  `configuration_generations`, `blocklist_domains`/`blocklist_stage`, `mac_vendors`, the
  fetch-state columns of `blocklist_categories`, and host settings keys (`interface_config`,
  ports, `dns_enabled`, `dhcp_enabled`, `backend_stack`, proxy bypass state, `update_*`,
  `backup_*`, setup state, `jwt_secret`, `restore_carryover`).
- **collected**: kept on the instance that produced it and copied up to the controller, never
  sent down. `metrics*`, DuckDB `dns_queries`, `anomaly_models`. A forced promotion loses the
  old controller's own collected history; the dialog says so.

### 2. Controller to member: a row log kept by triggers

Rejected: restore on a schedule (swaps the file, exits the process, copies host settings),
whole-table transfer (`ip_addresses` changes about once a client a minute), the SQLite session
extension (not compiled into better-sqlite3 13.0.3), WAL shipping (the file also holds host
tables and the blocklist cache).

- **Log**: `sync_log(seq, tbl, pk, op)` with one row per (table, key), so it holds current
  state plus tombstones and never grows past that. Every estate table has a single-column key
  (`id`, or `settings.key`, `blocklist_categories.slug`, `device_fingerprints.mac_address`).
- **Triggers** are generated from the registry and installed by `ensureSyncTriggers(db, mode)`
  in `initDb` after migrations and on every mode change, by diffing `sqlite_master`. That
  covers rebuild migrations, which drop triggers. They are plain SQL, so the anomaly sidecar's
  own connection and raw SQL in models are captured. Trigger body is delete-then-insert on the
  log (an `INSERT OR REPLACE` there breaks under `UPDATE OR IGNORE`). `check-db-ownership.js`
  gains a ban on `INSERT OR REPLACE` into estate tables.
- **Always on for the controller**, single box included, so the path is exercised everywhere.
  With no other members paired, tombstones are pruned at once.
- **Wire**: `GET /api/sync/changes?dataset=&epoch=&since=&schema=`, gzip NDJSON, long-poll when
  the member is current. A response is always the whole delta to head (coalescing makes a
  partial page inconsistent). A snapshot is the same format with every row.
- **Apply on a member**: download, verify the trailer hash, then one transaction with deferred
  foreign keys: deletes, then `INSERT ... ON CONFLICT DO UPDATE`, mirror the log rows and the
  cursor. After commit, `queueRegen` per touched table from the registry's hook map
  (`utils/after-commit.js`), and the matching proxy reloads. No restart.
- **Re-bootstrap** (snapshot) when the controller's `dataset_id` changed (restore, migration),
  the cursor is below the log floor, the epoch rule fails, or an apply throws. Different
  schema versions: sync pauses, the member keeps serving, the UI says which side to update.
- **Prerequisites**: `replaceLeases` (`models/dhcp-lease.js:34`) becomes a diff-upsert so a
  lease keeps its id; `syncDhcpDnsRecords` stops touching `updated_at` on unchanged records
  (`dhcp-lease.js:399`).

### 3. A member never writes estate data

- **Facts sink** (`server/src/sync/facts.js`): `leases`, `clientSeen`, `fingerprint`,
  `rogueEvent`, `daemonEvent`, `audit`, `queryRows`, `metrics`. `LocalSink` calls today's
  functions (the controller's own daemons, so every single box); `RemoteSink` queues and posts
  to the controller. Producers: `services/dhcp-lease-sync.js`, `utils/passive-liveness.js`,
  `utils/dhcp-fingerprint.js`, `services/dns-proxy-sinks.js`, `services/system-audit.js`,
  `utils/metrics-aggregator.js`, `db/duckdb.js`.
- **Mode-gated starts** in `server/src/index.js`: estate repairs at boot and controller jobs
  (scan scheduler, rogue detection, backup scheduler, audit prune, anomaly sidecar, shared
  defaults) run on the controller only. Scanning and rogue detection stay on the controller's
  host in 0.7.0; scanning from another member's segment is later work.
- **`syncDhcpDnsRecords` moves** out of `applyDhcp` (`services/backend-apply.js:52`) into the
  controller's lease ingest, so an apply is a pure render.
- **Write gate**: one middleware after `authMiddleware` refuses non-GET requests on a member
  with "This is a member of <controller>. Make changes there.", except an allowlist (sign-in,
  pairing, promote, interfaces, certificates, update, read-style POSTs). `permissionProjection`
  (`auth/roles.js`) drops write permissions on a member, so the client's existing `can()`
  gating greys out controls with no per-view work.
- **Database guard**: on a member, `BEFORE` triggers on estate tables abort unless the sync
  apply has its flag set. Stops the sidecar and stray SQL too.
- **Auth writes** on a member (`totp_last_step`, token `last_used_at`, preferences) go to a
  host shadow table or are skipped; backup codes are consumed through the controller only.

### 4. Facts up

- **Leases**: a member posts its full lease set (`BackendLease[]`, `backends/contract.js`)
  with its instance id, epoch and DHCP term. The controller accepts leases only from the
  instance named in the estate setting `dhcp_active_instance`, so `ingestLeases` keeps its
  replace-all meaning. Lease releases the controller wants ride back in the response and are
  acknowledged.
- **Other facts** carry the time they were observed; ingest honors it (liveness stamps "now"
  today, `models/ip-address.js:180,319`).
- **Controller away**: DNS and DHCP keep serving. New DHCP clients get their DNS names when
  the controller returns. Accepted for 0.7.0.
- **Analytics**: each instance keeps its own metrics rows and query rows as today and ships
  them up from a cursor; the controller stores them with an instance column. Analytics pages
  gain an instance filter (All by default); latency percentiles are shown per instance, not
  merged.

### 5. Trust and pairing

- Each instance gets a long-lived **sync identity certificate** in `DATA_DIR/sync/`, served on
  the same port by SNI. The web certificate is not pinned: it is replaced by upload and reset
  and never renewed.
- The controller makes a **join token**: one use, 15 minutes, carrying the controller's
  sync-cert fingerprint, so there is no trust on first use. The member exchanges it for a
  per-instance credential, stored hashed like `api_tokens` and replicated so a promoted
  controller knows the others.
- `utils/sync-client.js`: the only client allowed to call a private address with a pinned
  certificate. `utils/url-guard.js` stays as it is for everything else.
- The channel carries password hashes and TOTP secrets, because an admin must be able to sign
  in on a member while the controller is dead. The pairing dialog says a member is as
  sensitive as the controller. Facts from a member are untrusted input: existing lease
  rejection rules, the active-instance check and rate limits apply.

### 6. Clients find every member

- **DHCP DNS option**: `networkOptionFills` (`utils/dhcp-network-options.js`) and
  `syncServerDnsDefault` (`models/dhcp-option.js`) store one address computed on the writing
  host. This becomes a render-time list of every DNS-serving instance's address from
  `sync_instances`, the DHCP-active instance first. Canonical IP model gate: contract docs
  first, both families, differential tests.
- **NS records** (PowerDNS stack): one NS per DNS-serving instance with its address records,
  generated in `backends/pdns/render.js`. dnsmasq serves no NS; nothing to do there.

### 7. DHCP on one instance, and promotion

Both follow `services/stack-switch.js`: marker file, `holdHooks` and `holdLeaseSync`, the
deciding setting written last, recovery at boot.

- **Move DHCP**: quiesce the old instance, hand its leases over (the `handover/` snapshot and
  `importLeases` the stack switch uses), bump `dhcp_term`, start the new one. A stale instance
  that reports leases gets a refusal that tells it to stop DHCP.
- **Coordinated handover** (old controller reachable): freeze writes, wait for the target to
  reach head, move DHCP if needed, target becomes controller at epoch+1 in one transaction
  (mode written last), the old controller becomes a plain member of it.
- **Forced promotion** (old controller dead): typed confirmation showing the member's last
  sync time; epoch+1; taking over DHCP is a second confirmation that the old one is off.
- **Fencing**: every request carries the epoch. A controller that sees a higher one stops
  taking writes and stops DHCP. Members follow the highest epoch presented under a pinned
  certificate, found by trying the addresses in `sync_instances`.
- **Returning old controller**: fences itself, saves its database as a pre-demotion snapshot
  with a report of changes no member had received, then syncs from the new controller. No
  merge.
- **Not closable without a witness**: an old controller cut off from the members but still
  reachable by clients after a forced promotion (two controllers, possibly two DHCP servers),
  and a handover where the target stops answering after the point of no return. The UI states
  both in plain words where the choice is made.

### 8. UI

- First-run gains "Join an existing CIDRella" (controller address and join token) beside the
  normal path (`client/src/views/FirstRun.vue`, `routes/setup.js`).
- Header chip naming the mode (Controller, or Member of <name>, with sync state) through
  `StatusDot`; no banner.
- Settings, System, **Instances** (controller): the list with version, last contact, sync
  lag, DNS and DHCP state; Add member (join token); Move DHCP here; Promote. On a member the
  same page shows its controller and offers Promote.
- `GET /api/features` carries the mode; the client store reads it once, as it does features.

## Phases

Each leaves the tree shippable with single-box behavior unchanged. 

0. **Contract and groundwork.** `docs/REDUNDANCY-PLAN.md` (this design, tracked), ARCHITECTURE
   section and an ADR; registry and classification guard; lease diff-upsert; facts sink with
   `LocalSink`; grouped controller-only starts; `syncDhcpDnsRecords` moved. Refactor only.
1. **Change log.** `sync_log`, trigger generator, snapshot and delta endpoints, apply code, and
   a loopback test: random model writes, raw SQL and a second connection on one database,
   applied to another, then table-by-table equality.
2. **Member mode, DNS only.** Sync identity, pairing, sync client, sync loop, write gate,
   permission projection, guard triggers, first-run join, mode chip, Instances page.
3. **Clients find every member.** DNS option list and NS records.
4. **Facts and analytics.** Remote sink, ingest endpoints, instance column, analytics filter.
5. **DHCP on a member.** Active-instance move, lease reports, release commands. Highest risk:
   lifecycle writes arrive late from another host, under the canonical IP model gate.
6. **Promotion.** Coordinated, then forced, fencing, the divergence report.
7. **Hardening.** Version and schema skew, restore on the controller, backups on a plain
   member (off: it holds no record), UPGRADE and README, release notes, harness scenario.

## Verification

- Gates every phase: `npm test`, `npm run lint`, `npm run check:reuse`,
  `npm run check:db-ownership`, `npm run build:client`, both IP families where addresses are
  involved.
- **Loopback replica test** (phase 1) as above, plus: a rebuild migration, an
  `UPDATE OR IGNORE`, a cascade delete, a restore, a member days behind.
- **Tripwire test** (phase 2): boot a member-mode process on a seeded database with the log
  triggers installed, run every boot step and job, feed leases, liveness, fingerprints, proxy
  batches, a sign-in and an `applyDhcp`; assert the log is empty.
- **Two live instances**: testerella plus a throwaway LXC (destroyed after). Pair, edit a
  zone on the controller and query the member; stop the controller and confirm the member
  still answers and serves its UI read-only; move DHCP and check a client renews; coordinated
  handover and back; forced promotion with the old controller off, then bring it back and read
  its report.
- Playwright on the join path, the Instances page, and a member's read-only views.
- Never on prod. Prod takes 0.7.0 as a single box first; a second instance there is the
  maintainer's call.

## Open, with defaults

- Scanning and rogue detection only on the controller's host in 0.7.0.
- New DHCP clients' DNS names wait for the controller when it is away.
