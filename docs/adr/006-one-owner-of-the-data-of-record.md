# ADR 006: The Data of Record Has One Owner, and Everything Else Reports Facts

Status: accepted (2026-11-20)

## Context

CIDRella is growing from one instance to several (`docs/REDUNDANCY-PLAN.md`):
one controller that owns every write, and members that hold a synced copy and
keep serving DNS and DHCP when the controller is away. A copy is only a copy
while nothing on the member changes it. Before 0.7.0 that could not be said of
the code:

- Applying the DHCP config wrote DNS records (`applyDhcp` called
  `syncDhcpDnsRecords`).
- The lease sync deleted and reinserted every lease on every sync, so each
  lease got a new row id each time, and stamped every DHCP-made DNS record.
- Code that watches a daemon wrote what it saw straight into the tables: the
  lease sync, the DNS proxy's "this client just asked a question", the DHCP
  fingerprint watcher.
- Boot repaired the data, and timers changed it (scans, the stale sweep, audit
  pruning), all mixed in with boot work every box needs.

## Decision

1. **Every table and settings key has a data class**, in
   `server/src/sync/registry.js`: `estate` (the data of record), `host` (about
   this box alone) or `collected` (measured here, copied up, never sent down).
   A guard test fails on anything unclassified.

2. **A backend apply is a pure render.** `services/backend-apply.js` reads the
   database and writes nothing to it. Work that belongs around an apply
   listens: the DHCP name sync runs from `onDhcpRendered`, after the config is
   written and checked and before the backend takes it, exactly where it ran
   before.

3. **What an instance observes is a fact, and facts go to a sink**
   (`server/src/sync/facts.js`). The lease sync, the proxy's client reports and
   the fingerprint watcher call `facts()` and never write themselves. On an
   instance that owns the data the sink is `localSink`, which calls the same
   functions as before (`ingestLeases`, `recordDnsQueryLiveness`,
   `upsertFingerprint`).

4. **Work that changes the data of record on its own initiative is grouped**:
   `repairEstateAtBoot` and `startControllerJobs` in `server/src/index.js`.
   Only the owner runs them.

5. **A sync writes only what changed.** `replaceLeases` is a diff: a lease
   keeps its row and id, and one the backend lists unchanged is not written.
   `dhcp_leases.last_seen` is therefore when the lease was last new or changed,
   not when it was last listed. A DNS record a lease still answers is stamped
   once an hour instead of on every sync.

## Consequences

- A single box behaves as before. It is the owner, its sink is local, and it
  runs both groups.
- The retirement of a lease's DNS record that has no address row
  (`findRowlessDhcpRecordAddresses`) reads the record's stamp. With an hourly
  stamp it can run up to an hour early against a window of a day.
- Audit rows are not a fact in the sink yet. `recordAudit` is already the one
  place they are written, and it is switched when members exist.
- Metrics and DNS query rows are `collected`: each instance keeps its own, as
  today, so they need no sink.
- New code that learns something from a daemon or a client reports it through
  the sink. New code that changes the data on a timer goes in
  `startControllerJobs`. A new table or settings key is classified in the
  change that adds it.
