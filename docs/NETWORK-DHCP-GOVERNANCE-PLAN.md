# Canonical Network and DHCP Model Plan

Status: implemented in the current working tree on 2026-09-09. Schema 64 through
69, the canonical planner/executor, durable generation tracking, diagnostics,
UI preview flow, and permanent regression suites implement the decisions below.
Release-host browser and isolated live-client DHCP checks remain operational
release gates because this workspace has neither browser automation nor a
dnsmasq binary/network namespace.

## Purpose and scope

Make network creation, configuration, splitting, carving, merging, and deallocation consistent across topology, canonical IP state, DHCP configuration, and DNS projections. A successful database mutation must leave these models consistent immediately. A later scan, lease-file change, page refresh, or unrelated edit must not be required to repair it.

The motivating case is an allocated `1.1.1.0/24` with a last-usable gateway, divided into two `/25`s. The same rules must handle N-way division, repeated division, partial merges, and carve operations that produce unequal-sized remainder networks.

This is a companion to the existing [IP lifecycle plan](IP-LIFECYCLE-GOVERNANCE-PLAN.md), not a replacement allocation model. Read it with [Architecture](ARCHITECTURE.md), [API Model](API_MODEL.md), [ADR 001](adr/001-ip-protocol-table-ownership.md), and [ADR 002](adr/002-ip-topology-projection.md).

The audit covers the current working tree, including the earlier uncommitted IP classification and Network Defaults changes. Production was not inspected or changed. The reproductions explain the reported behavior locally, but do not establish the exact version, request mode, or data present on production.

## 1. Findings

### 1.1 Correct ranges can coexist with incorrect IP allocations

Evidence:

- [`subnet-topology.js`](../server/src/services/subnet-topology.js), `createSystemRanges`, writes Network, Gateway, and Broadcast **range rows only**.
- `configureSubnet` materializes usable IPs for prefixes `/20` and narrower. It does not materialize the ordinary network/broadcast endpoints. This makes the later behavior depend on whether an address already has an IP row.
- [`subnets.js`](../server/src/routes/subnets.js), `transferPerIpArtifactsToChildren`, and `subnet-topology.js`, `moveIpAddressesToSubnet`, transfer rows without reconciling their topology allocations.
- [`ip-address.js`](../server/src/models/ip-address.js), `moveToSubnet`, changes `subnet_id` and event ownership, not `allocation_state`.
- `GET /subnets/:id/ips` synthesizes topology allocations for missing rows in `makeVirtualIpRow`, but uses persisted rows as-is when present. [`ip-view.js`](../server/src/models/ip-view.js) then renders their persisted allocation state.

Consequences: a new network number, broadcast, or gateway can retain an old `unassigned` allocation. On merge, old child boundaries or gateways can retain obsolete protected allocations. A range/color-only fix would hide the inconsistency without fixing allocation eligibility, searches, counts, or DHCP.

### 1.2 Gateway intent is not a durable network policy

Evidence:

- `subnets` stores `gateway_address`, but no per-network first/last/custom/none policy. Migration [`029_folder_gateway_position.sql`](../server/src/db/migrations/029_folder_gateway_position.sql) is a comment documenting removal of folder-level gateway policy.
- Equal division in `subnets.js` infers first/last from the parent's current literal address. It already calculates the correct last-usable address for every child in the normal equal-split case.
- Carve mode uses different logic: only the child containing the old literal inherits it. Other children use the current global default.
- `subnet-topology.js`, `mergeSubnets`, always computes the merged gateway from the current global default. It does not recover the parent's earlier intent.
- [`NetworkDialogs.vue`](../client/src/components/NetworkDialogs.vue) infers the selected first/last control from a literal address. The UI selection is not persisted independently.
- Configure treats a falsey gateway as “use global default.” Update uses null-coalescing and a truthy gateway-change check. Explicit “none” is not reliably distinguished from omitted input.

The missing lower-child gateway marker is not evidence that equal division failed to calculate `.126`. In the reproduction it calculated and stored `.126` correctly, but did not promote its IP allocation. Carve and merge have additional policy errors.

### 1.3 DHCP options have several competing sources

Evidence:

- [`subnet-dhcp-topology.js`](../server/src/services/subnet-dhcp-topology.js), `insertScopeOptionsFromDefaults`, snapshots router, mask, and broadcast into `dhcp_scope_options`.
- `cloneParentScopesToChild` clips pool bounds but copies `dhcp_scopes.gateway` and all option rows verbatim. The lower `/25` can therefore inherit router `.254`, outside its network.
- [`dhcp-scope.js`](../server/src/models/dhcp-scope.js), `saveScopeOptions`, omits some explicit values equal to inherited network values. Its create/update path differs from topology scope creation.
- [`dhcp.js`](../server/src/utils/dhcp.js), `generateScopeConfig`, resolves global defaults, scope overrides, legacy columns, and network fallbacks itself. Global or explicit option 3 can override the network gateway.
- The generator discards explicit mask/broadcast options 1 and 28 and computes the range netmask from the current CIDR. Stale stored masks are therefore a database/UI inconsistency, **not proof that the generated range uses the old mask**. The stale router option does reach the generator's option map.
- [`ScopeDialog.vue`](../client/src/components/ScopeDialog.vue) reconstructs inherited options again. [`DhcpPanel.vue`](../client/src/components/DhcpPanel.vue), `scopeGateway`, chooses explicit option 3, then legacy scope gateway, then network gateway, without the generator's complete defaults logic.
- [`dhcp-lease.js`](../server/src/models/dhcp-lease.js), `syncDhcpDnsRecords`, selects domains from legacy scope/network fields. It does not consume the option resolver used to advertise DHCP domains, and multiple scopes overwrite a subnet-keyed map.

“The scope dialog defaults to the network gateway” is insufficient. The saved model, displayed effective options, emitted configuration, and DHCP-generated DNS must agree after subsequent topology edits.

### 1.4 Merge retains only one source network's scopes

`mergeSubnets` chooses the first allocated child with a gateway as `configSource`. It passes only that child to `moveScopesToSubnet`. Deleting the remaining children and ranges cascades away their scopes and options. The chosen source depends on request order.

The existing [`subnets-merge.test.js`](../server/tests/integration/routes/subnets-merge.test.js) explicitly tests preservation of the **configSource's** scope, not every source scope. That test passes while multi-scope loss remains possible.

Merge preview also reports that the selected child's gateway will be preserved, while execution recomputes a different gateway from the global default. The UI repeats the preview's promise.

### 1.5 Leases are not part of the transfer

- Divide moves reservations and IP rows, then `deleteDhcpStateForSubnet` deletes all parent lease rows, not just leases on newly unusable addresses.
- Merge moves reservations and IP rows but not leases. The `dhcp_leases.subnet_id` foreign key uses `ON DELETE SET NULL`, so deleting child networks leaves lease rows detached. This differs from the scope cascade behavior.
- [`dhcp.js`](../server/src/utils/dhcp.js), `syncLeases`, later assigns each lease to the first matching allocated subnet. Topology mutation must not depend on a later lease-file event to restore ownership.
- A database lease deletion is not a revocation of the client's lease. Existing route comments promising automatic renewal and “No connection drop” are not a safe operational guarantee.

### 1.6 Destructive conflict handling is incomplete and too broad

In `subnets.js`, `detectLossyIpsForDivision`:

- Checks reservations and selected IP metadata, but not lease-only evidence or all observation/history-only rows.
- Treats an existing protected boundary row as lossy rather than distinguishing an unchanged topology identity from a displaced host.
- Looks for A records only in the zone named by `parent.domain_name`. An assignment in another manual zone can be missed.
- Does not first restrict records in a shared forward zone to the source CIDR. Records belonging to other networks can be flagged `outside_selection`.
- Checks new boundaries, not the full set of newly selected gateway conflicts.

`cleanupLossyArtifactsAfterDivide` converts results to IP strings, then deletes reservation, lease, DNS A, and IP rows by address across the database. It does not limit deletion to the exact reviewed record identities. `moveReservationsToSubnet` also silently deletes destination MAC/IP duplicates before moving a reservation. `moveToSubnet` deletes duplicate destination IP rows.

These paths need explicit conflict decisions and preservation rules, not additional silent cleanup. Deleting an IP row can discard history as well as the allocation.

### 1.7 Split behavior changes by mode, pool size, and unrelated defaults

- Carve/custom-gateway branches can create a default scope on a non-inheriting child instead of projecting the original pool. Automatic scope creation runs before transferred IP/reservation/lease evidence is present in that child.
- `cloneParentScopesToChild` skips prefixes greater than `/29`. Preserving an existing scope should not use the same size cutoff as a convenience default for new scope creation.
- `excludeGatewayFromPool` retains only the larger side when a gateway lies inside a pool. The smaller valid interval disappears.
- Equal division accepts a selected subset without creating explicit remainder children. Evidence outside the selection can remain on a cleared container or be deleted by the lossy path.
- Custom organizational ranges are copied only if wholly contained, and only on inheriting branches. Spanning ranges are not split. Merge drops custom ranges.
- Child creation omits folder and scan policy fields. This can change effective scanning when the parent had an explicit override. Network mutations must not fabricate liveness or rogue flags.

### 1.8 Edge semantics and application completion need explicit contracts

- [`ip.js`](../server/src/utils/ip.js), `parseCidr`, treats `/31` and `/32` endpoints as usable. `createSystemRanges` skips them, but the IP route's virtual builder and lifecycle protection checks still identify numeric endpoints as system addresses. DHCP validation uses another endpoint rule.
- `calculateSubnets` uses signed 32-bit shifts for counts and sizes. Routes allocate the result before checking the 256-child limit. Prefix deltas of 31/32 can wrap, and large valid requests can allocate excessive work before rejection.
- `canMergeCidrs` requires equal-sized siblings and uses shift-based masks. Unequal carve remainders cannot currently be merged back even when their union is one exact CIDR. `/0` arithmetic needs dedicated tests.
- [`after-commit.js`](../server/src/utils/after-commit.js) deduplicates and serializes regeneration, but fires after a successful HTTP response. Failures are logged, without durable pending work or an API-visible applied generation.
- The existing ownership checker already restricts network, DHCP, range, and IP table writers, but explicitly allows both topology services and DHCP models. Ownership enforcement alone does not give them one invariant implementation.

## 2. Local reproduction and baseline

A temporary Vitest fixture used the existing migrated test database and Express route harness, with daemon/config regeneration mocked. It exercised create, configure, divide, IP reads, merge preview, and merge execution. No public IP was contacted. The fixture was removed after recording the results so the suite does not enshrine known bugs as desired behavior.

Common setup: parent gateway explicitly last-usable, global default deliberately `first`, original pool `.20` through `.240`, and one synthetic lease row. A second lease was inserted on a child before merge to inspect foreign-key behavior. Lease rows were database fixtures, not real client acquisitions.

| Case | Observed current behavior |
| --- | --- |
| `1.1.1.0/24` to two `/25`s | Network gateways `.126` and `.254` are stored correctly. IP `.126` remains `unassigned` despite its Gateway range. `.127` and `.128` remain `unassigned` despite their Broadcast/Network ranges. |
| DHCP on those `/25`s | Pools become `.20-.125` and `.129-.240`. Both carry explicit router `.254` and stored mask `255.255.255.0`. |
| Merge those `/25`s | Preview promises `.126`. Execution chooses `.1`, keeps only `.20-.125`, leaves `.1` unassigned and `.254` classified gateway. |
| `10.88.0.0/24` to four `/26`s | Correct gateway literals `.62`, `.126`, `.190`, `.254`, but only the old `.254` IP row is classified gateway. New internal boundaries remain unassigned. Four clipped scopes are created, all with parent router `.254`. |
| Merge those four `/26`s | Only one scope survives. The global first-usable gateway replaces last-usable intent. |
| Carve `10.89.0.0/25` from `/24` | Lower child gets `.1` and a new default `.17-.32` pool. Upper child keeps `.254` and original pool intersection `.129-.240`. This differs from equal division of the same prefix. |
| Leases | The original lease row disappears during each split. The inserted child lease survives each merge with `subnet_id = NULL`. |

The focused run passed 24 tests across five files, including the one temporary audit fixture. Existing tests therefore do not cover these cross-model invariants. Generated dnsmasq files and real lease renewal were not exercised by that fixture.

After removing the temporary fixture, `npm run test:server` passed all 1,044 tests across 90 files and `npm run check:db-ownership` passed. `npm run lint` still reports six existing `no-undef` errors in the ignored scratch scripts `tmp/create-testerella-preview-user.js` and `tmp/seed-testerella-anomaly-layout.js`. Those unrelated scripts were not changed. Document links and whitespace checks passed. No client/runtime changes were made for this audit, so browser and client-build validation are implementation gates rather than claimed results here.

## 3. Proposed canonical contract

These are the adopted canonical rules implemented by this change. Section 9
records the decisions used by the implementation.

### 3.1 Ownership and boundaries

| Fact or operation | Canonical owner | Other representations |
| --- | --- | --- |
| CIDR, hierarchy, operating-network status, gateway policy, network domain and scan policy | Network model and network lifecycle service | Tree, dialogs, derived boundaries and counts |
| Network/broadcast/configured gateway role | One server topology projection from the network model | Canonical IP allocation and immutable functional range/read projections |
| Allocation and allocation-conflict resolution | Existing IP lifecycle service and `ip-address.js` | `ip-view.js` fields used by every IP screen |
| DHCP scope policy and configured pool intervals | DHCP scope/pool models under the lifecycle orchestrator | Functional DHCP range display and dnsmasq range directives |
| Effective DHCP options and their provenance | One server DHCP resolver | Scope API, editor, summaries, generator, DHCP DNS synchronization |
| Reservation identity and lease observations | Existing DHCP reservation/lease models | Canonical IP lifecycle inputs, generated hosts and DNS |
| Manual DNS claims and managed PTRs | Existing DNS owners | Network operations request lifecycle/reverse reconciliation, not broad DNS deletion |
| Committed versus applied configuration | Durable configuration generation state | API operation status and retry diagnostics |

Keep a modular service with one database transaction, not a new distributed system or event-sourcing framework. Reuse the existing lifecycle, interval, DNS, generation validation, and atomic-write code where its behavior matches the contract.

### 3.2 Network identity, hierarchy, and gateway policy

1. Normalize CIDR on input. CIDR is authoritative for prefix, network, broadcast, address bounds, and counts. Persisted derivative columns are model-maintained caches, never independently editable facts.
2. Distinguish an organizational address-space container from an operating network. The existing status/hierarchy fields may represent this initially, but the model must enforce it. An operating network cannot overlap another operating network in the same supported address space. A container does not own active DHCP scopes or competing host allocations.
3. Each operating IP belongs to exactly one resulting operating network. CIDR containment and owner selection use one numeric server implementation, not SQL text order or “first matching row.” Preserve current single-address-space scope. Adding overlapping tenant/VRF support is a separate project.
4. Store network gateway intent as `first`, `last`, `custom`, or `none`. Store the custom literal only for `custom`. Expose the resolved `gateway_address` as a derived field or checked cache. Global Network Defaults supplies policy only when creating a new network without explicit policy.
5. Splitting a first/last parent assigns that policy to every operating child and computes each child's usable endpoint. A later global-default change does not alter existing network intent. A container retained after split keeps policy lineage without owning an active gateway allocation.
6. `none` is explicit and inheritable. Omitted means “default on creation” or “unchanged on edit,” not “none.” Do not silently introduce a gateway or scope during subdivision of a network configured without one.
7. Custom gateways require an explicit per-result plan. A custom IP may remain only in the child where it is usable. Other child policies must be supplied or accepted in preview. A custom IP that becomes a boundary is a conflict, not a valid inherited gateway.
8. Merging compatible first/last policies preserves that policy and recomputes the usable endpoint of the merged CIDR. Conflicting child policies, custom gateways, VLANs, or domains require resolution. Do not pick the first request element. Even a retained parent's policy is not permission to ignore explicit child overrides.
9. Treat folder placement, name, description, VLAN, reverse-DNS intent, and scan policy as explicit transfer fields. Preserve parent scan intent on children and per-IP overrides. Merge must preserve compatible values or show the differences. Flattening containers must not change effective policy.
10. Centralize address-family/prefix semantics. For ordinary IPv4 networks only the network number and broadcast are `system`. Gateway remains a separate allocation. Keep CIDRella/DNS/DHCP service addresses protected only by their actual protocol claims, including static DNS. Define `/31` and `/32` support consistently before allowing those topology operations. Reject unsupported DHCP/address-family combinations explicitly rather than silently discarding state. Do not extend this IPv4 work into DHCPv6 implementation.

### 3.3 IP lifecycle coordination

Topology edits change which topology claims exist. They do **not** introduce another allocation precedence tree.

- Compute old and new protected identities from the same topology projection.
- Inventory all persisted IPs and protocol claims in the affected address space, plus identities that acquire or lose topology roles. Do not enumerate entire large networks to populate empty hosts.
- Preserve stable IP row IDs where possible, metadata, interface identity, observations, retirement timestamps, and history while rehoming records.
- Move reservations and leases through their owners, then reconcile affected allocations through the existing IP lifecycle service in the same transaction.
- Release an obsolete topology claim through canonical reconciliation. Do not blindly write `unassigned`: an old gateway can still have an enabled manual DNS assignment and must become `static_dns` when appropriate.
- Add new topology claims only after conflicts have been resolved. A new gateway already occupied by a reservation, manual reservation, lease, or incompatible claim is not silently taken over.
- Existing topology-only boundaries are not host-data loss. A former host becoming a boundary is a reviewed conflict. Preserve observation/history evidence even when an approved active claim must be retired.
- Read projections for virtual and persisted rows, search, pagination, grid/table, details, and counters must agree. Consolidate virtual topology handling with the documented server projection. Do not teach the client to override persisted allocation state.
- A topology change never counts as a ping, lease renewal, or host observation. New rows start without liveness evidence. Preserve legitimate online/rogue observations, then recompute any topology-dependent conflict projection through its owner.

Useful invariant: moving an IP between networks changes its location, not its observed activity or claim ownership, except for the explicit topology-role changes listed in the accepted plan.

### 3.4 DHCP scope, pool, and option model

Recommended end state:

- A scope belongs to one operating network and owns policy such as enabled state, lease duration, explicit non-topology options, and description.
- A scope has one or more configured, non-overlapping pool intervals. This represents holes without discarding half a pool or duplicating a policy for each exclusion.
- Pool ownership is not duplicated between `dhcp_scopes.subnet_id` and an independently editable `ranges.subnet_id`. Introduce a DHCP-owned pool representation, with functional range display projected from it. Keep organizational custom ranges independent.
- Migrate the existing one-scope/one-range representation through an adapter first. Do not deploy two authoritative pool stores. Remove legacy scope gateway/domain/DNS columns only after all readers and writers use the canonical option representation.
- Separate configured pool intent from effective dynamically offerable segments. Exclude protected topology and incompatible allocations using the IP contract. Manual reservations already use generated interval exclusions today. Enabled manual DNS must never become leaseable, including CIDRella's DNS-assigned IP.
- Fixed DHCP reservations may lie within a configured scope, but cannot be dynamically offered to another client. Preserve existing reservation semantics rather than rejecting all non-unassigned addresses indiscriminately. Valid active dynamic leases are not themselves pool-definition conflicts.
- Pool creation and resize retain the IP contract's rejection rules for static-DNS conflicts. A legacy conflicting scope needs an explicit split/repair decision. The generator also validates eligibility so a bypassed writer cannot emit an unsafe dynamic range.
- Split and merge preserve whether DHCP service is configured, not the old pool bounds. If any source network has a scope, each supported resulting operating network receives the same default-sized pool used when a new network is allocated with “Create DHCP scope.” Preview discloses the exact replacement interval. A source with no scope never gains one implicitly.

One resolver returns both values and provenance:

| Option group | Proposed authority |
| --- | --- |
| Mask (1), router (3), broadcast (28) | Target network topology. No hidden global/scope override of these network facts. |
| Lease duration / option 51 | One normalized scope lease policy, initialized from creation defaults. No competing duration column and generic override. |
| Domain/search (15/119) | Explicit scope policy if supported, otherwise network policy, then documented defaults. DHCP-generated DNS consumes the same resolved naming policy. |
| DNS, NTP, PXE, other supported options | Explicit scope override, then the documented inherited/default policy. Preserve per-option enable/suppress semantics. |

Keep global option values and “enabled for new scopes” distinct. Specify whether each inherited default is live or snapshotted. Recommended: ordinary explicitly inherited options remain live and expose their source, while creation presets seed explicit policy only when requested. Capture the effective values and defaults revision in a mutation preview so intervening settings changes invalidate it.

Network-derived router is the recommended standard policy, matching the user's requirement. Existing option-3 overrides or router lists may represent intentional deployments. Inventory and block ambiguous migration cases, rather than overwriting them. If multi-router support is retained, represent it explicitly in the network routing model. Do not leave it as a competing scope-owned gateway.

For `none`, verify the generated dnsmasq directive suppresses automatic router advertisement as intended. Merely omitting an option may not express that intent. This is a required disposable-daemon test before the feature ships.

### 3.5 Split and merge semantics

All supported operations compile into one transformation plan over source and target CIDR sets:

- Equal split supports `2^k` children, not just two. Validate the output count before generating children.
- Carve produces the selected CIDR plus the exact remainder cover, using the same transfer rules as equal split.
- A selected subset must leave explicit remainder ownership. It must not silently abandon or delete the unselected space. Whether remainder nodes remain operating or become containers/unallocated must be visible and must preserve or explicitly retire their facts.
- Merge requires an exact, gap-free, non-overlapping union that is one aligned CIDR. Support unequal-size leaves whose exact union satisfies that rule so carve can be reversed. Initially retain the sibling requirement. Cross-parent reparenting requires a separate explicit operation.
- Partial merges preserve unaffected siblings. Container consolidation and automatic buddy merge must go through the same planner or be restricted to provably empty, policy-compatible nodes.

Scope transformation algorithm:

1. Determine whether any source network has a DHCP scope, including a disabled scope.
2. If no source scope exists, create no scope on the result.
3. If a source scope exists, create exactly one default-sized pool on every supported resulting operating network. Use the same sizing function as allocation with “Create DHCP scope,” and disclose every interval in preview before execution.
4. Preserve the source scope's enabled state, lease duration, description, and non-topology option policy. Recompute mask, router, and broadcast from each target network. If multiple source scopes differ on retained policy, block for resolution instead of choosing one.
5. Do not project, union, or restore old configured pool bounds during split or merge. Topology transformation cannot infer whether old gaps or asymmetric pool sizes remain appropriate after the network boundary changes.

Reservations and leases:

- Rehome every valid reservation and current/retained lease by target ownership. Preserve expiration, client ID/MAC, enabled state, hostname facts, and IP history.
- A moved lease must not appear newly observed just because its network ID changed. Lease watcher reconciliation must distinguish ownership changes from actual renewal/activity.
- Detect duplicate reservation identities produced by a merge before mutation. Deduplicate only provably identical records under an explicit rule with traceable source IDs. Conflicting reservations require a decision.
- Active leases that become a boundary, gateway, or otherwise invalid address block an ordinary operation. The plan must distinguish a safe future pool change from disruption to currently connected clients.
- Do not assume deleting database rows updates a client or the daemon's lease file. Any release/renewal workflow is an explicit operational step with separately tested behavior.

### 3.6 Expected motivating result

For last-usable policy:

| Target | System network number | Usable addresses | Gateway | System broadcast |
| --- | --- | --- | --- | --- |
| `1.1.1.0/25` | `1.1.1.0` | `.1-.126` | `1.1.1.126` | `1.1.1.127` |
| `1.1.1.128/25` | `1.1.1.128` | `.129-.254` | `1.1.1.254` | `1.1.1.255` |
| Combined `1.1.1.0/24` | `1.1.1.0` | `.1-.254` | `1.1.1.254` | `1.1.1.255` |

Usable addresses include the gateway address as a host position, but the configured gateway is not available for client allocation.

For a scoped `/24`, splitting into `/25` networks creates the standard `/25` default pools `.17-.32` and `.145-.160`. Their effective DHCP routers are `.126` and `.254`, with `/25` masks. Merging scoped children creates the standard `/24` default pool `.33-.64`, with router `.254` and a `/24` mask. Old pool bounds are not treated as intent for the newly shaped network.

A four-way `/26` split produces gateways `.62`, `.126`, `.190`, and `.254`. All four must be canonical gateway allocations and all resulting scopes must use their own target network's routing facts.

## 4. One preview and execute pipeline

```text
Request + current model snapshot
  -> validate and compile deterministic transformation plan
  -> preview targets, gateway/pool changes, conflicts, and client impact
  -> accept exact plan and explicit conflict decisions
  -> transaction: revalidate revision, transfer facts, reconcile IPs, validate invariants
  -> commit model + audit + pending configuration generation
  -> validated DNS/DHCP apply, retry/status, invalidate affected read caches
```

Suggested plan payload:

- Operation kind, source IDs/CIDRs, target CIDRs and stable target keys.
- Source topology/configuration revisions and a dependency snapshot token, including relevant claims, lease changes, and defaults. Timestamps with one-second resolution are not sufficient concurrency guards.
- Per-target resolved gateway policy/address and metadata inheritance.
- Scope/pool lineage, before/after intervals, effective option differences, enabled state, and capacity counts.
- Exact IP, reservation, lease, DNS record, and history actions identified by row IDs and canonical identity, not only IP strings.
- Blocking conflicts with reason codes, affected identities, supported resolutions, and disruptive effects. “Force” is not a blanket waiver of invariants or authorization.
- Unaffected/remainder ownership, warnings, and operational cutover requirements.

Preview and execution invoke the same planner. Execution recomputes or verifies the accepted plan inside the write transaction. A new DNS record, lease renewal, scan observation affecting a conflict, scope edit, or default change after preview must not be silently overwritten. Return a stale-plan conflict with a refreshed preview when relevant dependencies changed. Unrelated observations need not invalidate every plan globally.

Transaction requirements:

1. Check permissions for the compound operation. Existing `subnets:write` must not silently bypass restrictions on DHCP or DNS changes. Define whether a dedicated topology permission or the affected resource permissions authorize the plan.
2. Validate and create/update target network metadata and policy.
3. Move existing IP identities and protocol facts through canonical owners. Stage scope/pool transformation without enabling partial output.
4. Apply approved claim changes, reconcile topology and remaining allocation claims, and reconcile managed DNS/PTR projections using existing naming policy.
5. Verify containment, uniqueness, allocation consistency, pool safety, references, and conservation before deleting emptied source records or ranges.
6. Record exact mappings and decisions, update revisions, and enqueue durable configuration work in the same transaction.
7. Commit once. Rollback restores all affected tables, events, and revision state if any step fails.

Application requirements:

- Keep validated dnsmasq generation and atomic file replacement. Add durable desired/applied generation tracking and retry around the existing after-commit mechanism.
- API/UI distinguish “model committed, configuration pending,” “applied,” and “apply failed.” A successful database write is not proof the daemon accepted the new configuration.
- Validate complete generated DNS/DHCP output before replacing the active set. On failure keep the last validated files and expose that they are behind the model. Do not blindly roll back the database after subsequent mutations or lease observations.
- On restart, discover and apply pending work idempotently. Order dependent DNS/DHCP updates consistently.
- Invalidate network tree, IP details/search/stats, DHCP views, scan ownership, and relevant topology caches from the lifecycle operation, not only an Express response hook.
- Reject stale scan results targeted at removed network IDs or rehome their observations through validated current ownership. Do not let background work recreate stale topology.

## 5. Implementation sequence and exit gates

### Phase 0: contracts and characterization

Deliverables:

- Approve section 9 decisions and add the canonical Network/DHCP contract to Architecture and API Model.
- Add a Network/DHCP ownership ADR. Clarify that functional `range_types.is_system` does not mean every IP in that range has allocation state `system`.
- Align IP governance wording: the address-family table currently allows a DHCPv4 scope option as a gateway source, and the migration bullets still say appliance addresses become protected. Reconcile those with the agreed network source and ordinary static-DNS treatment of CIDRella.
- Add permanent failing regression cases for the reproduced defects, based on desired results rather than snapshots of the buggy behavior. Keep existing protection, DNS, and reservation tests.
- Inventory write/read paths and legacy data before changing migrations.

Exit: policies are explicit, critical failures reproduce in isolated tests, and each invariant has an owner and test.

### Phase 1: canonical network projection and policy

Deliverables:

- Introduce a network persistence/read model and gateway/topology projection. Keep `subnet-topology.js` as the coordinating service or rename it behind compatible route adapters.
- Add checked per-network gateway policy and revision fields through an append-only migration. Preserve legacy gateway intent conservatively, with ambiguous inference reported.
- Use the same CIDR and endpoint semantics for creation, configure/update, allocation guards, virtual reads, and DHCP validation. Check large split counts before enumeration.
- Add IP lifecycle reconciliation for added/removed topology claims, preserving DNS-backed former gateways and existing IP identities.
- Make create/configure/edit gateway defaults, explicit none, scan policy, and field omission semantics consistent before changing every topology branch.

Exit: direct network edits keep persisted/virtual IP views consistent at every supported prefix and do not invent liveness.

### Phase 2: canonical DHCP policy and effective read model

Deliverables:

- Add the shared option resolver and server-owned scope view with provenance and effective intervals.
- Route direct scope CRUD, range-backed scope CRUD, network configure, and topology adapters through the same validation/model layer.
- Move toward scope-owned pools and remove duplicated network ownership. Use one authoritative store at each migration step.
- Convert network-derived option snapshots only where intent is unambiguous. Inventory overrides, normalize lease duration, and remove legacy fallbacks after all consumers migrate.
- Make scope UI, generated configuration, and DHCP-generated DNS consume the same effective values.
- Tighten ownership checks so topology orchestration calls model writers instead of bypassing their invariants.

Exit: equivalent scope creation through every supported entry point produces equivalent canonical state and emitted configuration. No gateway or static-DNS address is dynamically offerable.

### Phase 3: unified transformation planner and atomic execution

Deliverables:

- Replace equal/carve/merge-specific transfer policies with one plan/apply engine.
- Transfer all scopes, pools, reservations, leases, IP identities, and custom range fragments. Include field inheritance, remainder cover, compatible coalescing, and partial merge behavior.
- Replace broad `force_lossy` deletion with exact, reviewed conflict actions. Remove silent duplicate overwrites.
- Handle restored parent, new intermediate merge result, repeated splits, unequal exact-cover merges, and safe buddy consolidation through the same invariant checks.
- Implement revision/conflict guards and transactional audit mappings.

Exit: section 6's cross-model scenario matrix passes through HTTP and service entry points. Permuting merge inputs does not change the result. No source artifacts disappear without a reviewed action.

### Phase 4: generation, UI, and background integration

Deliverables:

- Add durable pending/applied generation and retry behavior without replacing the existing validated writers unnecessarily.
- Replace misleading gateway-preserved/config-loss copy with the actual plan. Show per-target routers, pools, conflicts, active-client impact, and explicit resolutions.
- Make both equal and carve UI flows use the server preview rather than client-only arithmetic as the authoritative result.
- Update lease watcher, scanners, reverse DNS reconciliation, and cache invalidation to consume current ownership and revisions.
- Browser-verify two-way and four-way split, merge, gateway-none/custom decisions, and apply-failure status in the rendered application.

Exit: generated files match the canonical read model, delayed/failing apply is visible and recoverable, and background observations cannot restore old ownership.

### Phase 5: migration, repair tooling, and controlled release

Deliverables:

- Build a read-only inventory with exact inconsistencies: topology/IP mismatches, out-of-network gateway options, detached leases, missing/conflicting scopes, stale option snapshots, source IDs, range overlaps, and shared-zone records.
- Separate safe derived-state repair from ambiguous intent or missing historical data. Do not reconstruct a lost pool from a global default and claim it was recovered.
- Implement reviewed repair through the same lifecycle operations. Recover deleted scope/lease facts from a known backup only when available and explicitly approved.
- Test fresh install, legacy upgrade, already-split data, migration idempotency, and restart with pending configuration. Choose the next available migration number at implementation time. Do not modify existing numbered migrations or reuse burned version 048.
- Prepare backup, restore, schema compatibility, operational cutover, and rollback instructions. Never use the destructive release harness against production.

Exit: full validation passes, migration ambiguities have actionable reports, disposable-host DHCP testing succeeds, and the maintainer approves deployment. No commit, tag, push, or deployment is implied by this plan.

## 6. Synthetic regression strategy

### 6.1 Harness and independent oracle

Use Vitest and the existing temporary-database/Express helpers. No production network, public ICMP, real interface, or daemon is required for the normal suite. Freeze time and inject lease/scan observations. Use RFC-style documentation/private test addresses except the isolated numeric `1.1.1.0/24` reproduction fixture.

Implemented test seams and files (some originally proposed unit cases are
covered by the existing model suites rather than new file names):

- `server/tests/helpers/network-dhcp-fixture.js`: networks, scopes, disjoint pools, enabled/disabled reservations, active/expired leases, manual and generated DNS, PTRs, IP observations/history, and defaults.
- `server/tests/helpers/network-dhcp-oracle.js`: independent numeric/set expectations and invariant checks. Do not call the implementation's planner to calculate expected results.
- `server/tests/unit/models/network.test.js` and `dhcp-effective-options.test.js`: bounds, policy resolution, options/provenance, and pool eligibility.
- `server/tests/integration/network-dhcp-transformations.test.js`: table-driven cross-model split/merge/carve scenarios.
- `server/tests/integration/network-dhcp-differential.test.js`: equivalent operations through different API/service paths and operation orders.
- `server/tests/integration/network-dhcp-generation.test.js`: real config emitter pointed at temporary directories, with only daemon execution and external name resolution stubbed.
- `server/tests/integration/network-dhcp-migration.test.js`: previous schema/data shapes, ambiguous intent, safe repair, and no-op reruns.
- Client tests for preview rendering, conflict decisions, inherited policy, and committed-versus-applied states.

For small prefixes enumerate the complete expected host set. For large prefixes use interval identities and bounded samples so the oracle itself cannot exhaust memory. Use seeded generated cases and save the seed and minimal failing topology on failure. A property-testing dependency is optional, not a prerequisite.

### 6.2 Required scenario matrix

| Dimension | Required cases and assertions |
| --- | --- |
| Split cardinality | `/24` into 2, 4, 8, and maximum allowed children. Each target has correct boundaries, usable count, gateway policy, scope projection, and allocation roles. Reject excessive count before allocation. |
| Split modes | Equal division versus equivalent carve, repeated division versus direct division, selected subset plus remainder, unequal remainder cover. Equivalent final partitions preserve equivalent facts. |
| Merge shape | Two/four/eight siblings, partial merge leaving siblings, restore original parent, create intermediate result, unequal exact-cover leaves. Reject overlaps, gaps, duplicate IDs, nonaligned union, and unsupported cross-parent merge. |
| Gateway policy | First/last with opposing global default, global change between operations, explicit none, custom interior address, custom address becoming a boundary, conflicting child policies, new gateway occupied by each claim type. |
| Prefix/address math | `/0` and upper IPv4 bounds using bounded validation, `/19` versus `/20` materialization boundary, `/29` versus `/30` scope-preservation boundary, explicitly supported `/31` and `/32` semantics, malformed prefixes and overflow counts. |
| Pool shape | Whole host space, subset, crossing every new boundary, multiple scopes, disjoint intervals, adjacent compatible intervals, singleton/empty result, gateway at each edge/interior, explicit gaps, pool-policy differences. No silent capacity addition or loss beyond reviewed exclusions. |
| Scope policy | No original scope, disabled scope, different lease durations, DNS/search/PXE settings, overrides equal to defaults, live inheritance versus snapshot, changed defaults, conflicting topology options. No accidental enablement. |
| IP authority | Persisted and virtual boundaries/gateways, DNS-named old gateway, CIDRella manual DNS, manual reservation, static DHCP, valid dynamic lease, observed-unassigned, quarantined conflict. Compare allocation source and display fields, not only color or ranges. |
| Lease preservation | Active, expired-retained, infinite, lease-only row, reservation-backed lease, client identity, renewal during preview, refresh after transfer, invalid new boundary/gateway. No lease detachment or artificial liveness refresh. |
| Reservations | Same MAC on separate children, identical duplicates, conflicting duplicates, enabled/disabled, crossing target ownership, fixed reservation inside a pool. Never silently choose a winner. |
| DNS/PTR | Shared forward zone with unrelated external-network records, manual zones not named by the subnet, generated names, multiple aliases, reverse policy, manual PTR precedence. Preserve canonical naming policy and exact unrelated records. |
| Metadata/hierarchy | Spanning custom ranges, network/per-IP scan overrides, folders, VLANs, domains, descriptions, IDs/events, container flattening, unallocated networks with evidence. |
| Read consistency | Grid/table details, search, available filtering, sorting, page boundaries, counts, scope summaries and editor. Persisted and virtual shapes yield the same canonical topology roles. |
| Background timing | Scan begun before split, lease-file replay after merge, DHCP DNS sync before/after operation, retirement tick, cached network lookup. No stale owner recreation or double attribution. |
| Authorization | Preview cannot mutate. Compound writes enforce the chosen permission contract. Conflict acknowledgment cannot authorize out-of-scope record deletion. |

### 6.3 Invariants and differential properties

- CIDR union is conserved, except separately authorized address-space removal. Targets are disjoint and contained in the source union.
- Every moved host fact has exactly one destination or one explicit disposition. No unexplained record loss, detached lease, dangling source ID, or reference to a deleted network remains.
- Protected IP identities exactly match the target topology. All other allocations come from the existing IP lifecycle contract.
- Dynamically offerable addresses are a subset of configured pool intent and target usable addresses, with required exclusions. No topology operation creates leaseable static-DNS addresses.
- Scope enabled state and unrelated explicit option policy are conserved. Generated router/mask/broadcast semantics match the target network.
- Observations and retained expiry/history do not advance just because a topology edit ran.
- Merge permutations produce equivalent policy and data. ID allocation and audit timestamps may differ, but semantics may not.
- Direct N-way split and repeated smaller splits yield equivalent final partitions, policy, and surviving host facts where there were no intermediate host conflicts.
- Split then merge restores the original address space, gateway intent, and surviving host facts. Do **not** assert byte-for-byte pool equality: newly required exclusions remain holes unless an explicit expansion restores them. Tests must distinguish configured interval history from effective offerable coverage.
- Equivalent scope creation/configuration through scope CRUD, range CRUD, configure, and transformation paths yields the same canonical read model and generated output.
- Operation replay is idempotent or returns an explicit already-applied result. Failed transactions leave the entire database and pending-generation state unchanged.

### 6.4 Failure and generated-sink tests

Inject failures after target insertion, scope projection, reservation/lease moves, IP rehoming, lifecycle reconciliation, source cleanup, and audit/generation enqueue. Compare before/after snapshots of all affected tables and check foreign keys.

Change relevant policy/claim/lease state between preview and execution. Verify stale-plan rejection without partial writes. Retry execution and generation around simulated process restart, duplicate requests, invalid generated config, file-write failure, and failed daemon restart.

Do not mock `regenerateScopeConfigs` in the generated-sink suite. Parse actual temporary `dhcp-range` and tagged option output, assert effective router, mask, lease duration, exclusions, every surviving scope, and stale-file cleanup. Inspect generated reservations and DNS/PTRs as well. Verify failure leaves the previous validated artifact set intact.

Add an opt-in disposable-daemon test for acquisition/renewal, gateway-none behavior, multiple tagged scopes, and active leases during cutover. It must use an isolated network namespace or designated throwaway host, never the management LAN or production. Offline config assertions are necessary but do not prove client behavior.

### 6.5 Validation commands and completion criteria

Use the repository's documented commands:

```sh
npm run test:server
npm run test:client
npm run lint
npm run check:db-ownership
npm run build:client
```

For focused iteration, run `npx vitest run` with the relevant checked-in test paths from `server/` or `client/`. `npm test` runs both relevant full suites. Run the formatter/linter behavior documented in `CLAUDE.md`, not an invented mass formatter.

Release criteria: all invariants above, focused and full suites, lint, ownership checks, client build, rendered browser scenarios, migration rehearsal, and isolated daemon checks pass. Green pre-existing tests alone are not acceptance.

## 7. Migration and operational safeguards

Existing data needs an inventory before any automatic repair:

- Infer first/last from legacy literal endpoints only under an explicitly adopted migration rule. Mark inference provenance. Do not claim to recover an original UI choice that was never stored.
- Missing gateway is not proof the network should use the current global default. Preserve none unless another authoritative record establishes intent.
- A scope option equal to an old parent gateway might be a stale snapshot or intentional override. Use available lineage/audit/backup evidence. Report ambiguity instead of guessing.
- Safe repairs include recomputing derived boundaries and projecting conflict-free topology roles. Unsafe repairs include choosing among DNS/reservation claims, replacing router lists, reviving deleted scopes, or removing active leases.
- Snapshot every source record needed for rollback before destructive approved changes. Restoration after clients renew is an operational recovery, not just reversal of a SQL transaction.
- Splitting an IPAM network does not configure physical router interfaces, VLANs, relays, or clients. A new default gateway address must exist operationally before clients are told to use it. Preview should call out that dependency and the potential interruption from subnet-mask/router changes.
- Public-address liveness, including the earlier online/rogue report, is a separate diagnostic. The transformation tests assert no fabricated liveness and preserved scan policy, but this audit did not diagnose production scanning.

## 8. Repository hygiene noted during the audit

The path/pattern scan found no tracked private-key payload or credential file in the checked locations. Certificate UI placeholder strings are not embedded keys. This is a targeted hygiene check, not a complete secret audit.

Ignored local artifacts still include a production-credential note and a private key with mode `0600`, plus `server/data/cidrella.db` with mode `0644`. Move credentials to the approved secret store and restrict the database to the service/developer account as appropriate. Do not include these artifacts in fixtures, screenshots, commits, or release bundles. No contents were reproduced and no permissions or credentials were changed during this audit.

## 9. Adopted implementation decisions

The implementation uses these defaults, with the non-obvious tradeoffs called out:

1. **Persist gateway intent and inherit first/last on all split children.** Compatible merges preserve it. Global defaults apply only to new independent networks. This matches the motivating request.
2. **Network routing facts own DHCP router configuration.** Legacy divergent scope routers need migration review. Supporting multi-router DHCP means adding an explicit network routing policy, not preserving an invisible second authority.
3. **Preserve DHCP scope presence and replace pool bounds.** If any source
   network has a scope, create one standard default-sized pool for every
   supported result, inherit deterministic source policy, and disclose the
   exact replacement in preview. Do not project, union, or restore old bounds.
4. **Block conflicting active leases/admin claims by default.** Provide exact planned resolutions and operational warnings. Do not interpret “divide this network” as permission to delete unrelated or unlisted records.
5. **Preserve all remainder space and support exact-cover unequal merges.** This makes carving reversible. Keep cross-parent merges out of the first implementation.
6. **Use explicit policy for custom/none gateways and unsupported narrow prefixes.** Never invent defaults or silently drop DHCP state when inheritance is ambiguous.
7. **Treat DHCP apply status separately from database completion.** Show pending/failure and retry safely. This avoids promising that clients have changed just because a network mutation returned success.

The minimum safe implementation is more than a gateway recalculation: phases 0
through 4 establish the shared invariant and its sinks, and phase 5 makes
existing installations safe to migrate.

## 10. Implementation and validation record

The implementation adds persistent gateway policy and topology revisions,
scope-owned pool intervals, canonical scope lease duration, durable generated
configuration state, current-owner scan checks, a deterministic plan with exact
record conflicts, and safe/unsafe diagnostics. Split, carve, and merge execute
inside one transaction and enqueue generation in that transaction.

Permanent tests cover direct versus repeated split, unequal carve and exact-cover
merge, merge permutation behavior, multi-scope/pool gaps, gateway exclusions,
reservations, leases, manual DNS in shared zones, spanning custom ranges, scan
policy and stale scans, injected rollback, stale plan rejection, generated files,
migration rehearsal, restart recovery, diagnostics, client plan-token handling,
`/0`, upper IPv4 arithmetic, overlap rejection, and the 256-child cap.
