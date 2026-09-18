# Workspace UI implementation plan for 0.5.0

Status: proposed implementation specification, not an implementation-completion report.

Baseline: `dev/0.5.0`, commit `12a9731`, inspected 2026-09-12. The working tree was clean before this document was added. The rendered reference is `http://172.19.87.89:5173/networks-preview`. That address is a development reference, never an application configuration default.

Navigation: [scope](#1-objective-and-scope), [design decisions](#2-decisions-to-preserve), [navigation](#3-information-architecture-and-navigation), [current gaps](#4-baseline-gaps-and-required-treatment), [file ownership](#5-component-and-code-ownership), [API prerequisites](#6-api-prerequisites-and-additive-contracts), [refresh rules](#7-mutation-and-refresh-contract), [Networks/IP/ranges](#8-network-address-and-range-work-packages), [DNS/DHCP](#9-dns-and-dhcp-work-packages), [rest of application](#10-application-wide-parity-map), [shared UI](#11-shared-workspace-work-packages), [tests](#12-test-specification), [implementation order](#13-ordered-implementation-sequence), [completion](#14-definition-of-done-and-unresolved-limits), [endpoint index](#appendix-a-existing-endpoint-coverage-index).

## 1. Objective and scope

Carry every existing operator workflow into the tuned workspace design. Deliver Networks, DNS and DHCP as one contextual work surface first. Map Analytics, Settings, account management and appliance operations into the same visual language in subsequent phases. Keep the current interface available during implementation and keep new presentation code separate at the file level.

The application-wide scope is the planning assumption. The first release gate is full IP-management parity. The later application-wide gate includes all the destinations in section 10. Neither gate means changing IP policy, adding a new DHCP implementation, replacing the widget toolkit again, or deploying this document's proposals automatically.

This is an implementation specification, not a second backlog. Record actual progress and blockers in `BACKLOG.md`, referring to the work IDs below. Do not duplicate that tracking here. Change this document when a design decision or contract changes.

### 1.1 Source precedence

1. User decisions in this thread and applicable `AGENTS.md` instructions.
2. Canonical behavior: [architecture](ARCHITECTURE.md), [API model](API_MODEL.md), [IP lifecycle governance](IP-LIFECYCLE-GOVERNANCE-PLAN.md), [network/DHCP governance](NETWORK-DHCP-GOVERNANCE-PLAN.md), and IP/network ADRs.
3. Current server route validation, model/service behavior and their regression tests.
4. Tuned preview for layout, color, density and interaction placement.
5. Existing UI for feature inventory and user-entered fields, not as a policy authority.

Older documentation is not uniformly current. For example, `docs/SESSION-STATUS.md` predates this branch state, and some prose still says PrimeVue although `client/src/ui/Button.js` now imports OpenVue. Follow the checked-in UI seam and `--cid-*` tokens. This plan does not require external toolkit research or a dependency change.

### 1.2 What was inspected

- Browser: authenticated preview, All Networks, selected network, address table and compact-grid navigation. The development instance displayed a `/22`, five zones and one scope. These counts are evidence of a live binding, not test fixtures or expected release values.
- New presentation: `NetworksWorkspacePreview.vue`, `networks-workspace-data.js`, `networks-workspace/AddressDetailsPanel.vue`, their tests, and the separate anomaly preview.
- Existing workflows: `SubnetsLayoutB.vue`, `SubnetDetail.vue`, `FolderNetworkTable.vue`, `NetworkDialogs.vue`, `DnsPanel.vue`, `DhcpPanel.vue`, `ScopeDialog.vue`, `IpDetailsDrawer.vue`.
- Application coverage: router, `settingsAreas.js`, page components, stores, column catalog, auth and all route modules listed in Appendix A.
- No live writes, scans, DHCP activation, imports, resets or deployments were performed for this plan. Browser inspection is not an end-to-end mutation test.

## 2. Decisions to preserve

| ID | Design contract |
| --- | --- |
| UX-01 | Keep a single central work surface. Selecting a network establishes context for Addresses, DNS, DHCP and Ranges. Do not restore separate DNS/DHCP inventory buttons at the top of the explorer. |
| UX-02 | Keep the existing **All Networks** label pending a naming decision. It exposes Networks, all DNS zones and all DHCP scopes. The label does not limit its contents to networks. |
| UX-03 | Explorer remains at left, selected context and gauges above the central surface, resource details at right. Global configuration belongs in Settings. |
| UX-04 | Keep Table, Grid and Compact Grid address presentations. The same row identity, action eligibility and selection model drive all three. |
| UX-05 | Related-resource navigation retains the right panel. The panel owns a stable resource identity independently of the active table. |
| UX-06 | Keep the font sizer. It changes text whose unadjusted size is below 11 pt, up to 11 pt. Text already at least 11 pt does not shrink or grow. Preserve the current 0, +1, +2 pt choices and saved preference. Apply it to explorer secondary text, tables, quick actions and detail panels. |
| UX-07 | Keep teal workspace emphasis, amber DNS and violet DHCP using semantic workspace variables over `--cid-*`. Preserve supported themes. Status is conveyed by text/icon as well as color. |
| UX-08 | The Scan now / Actions / Create group stays right-aligned on the context-title row. Gauges occupy remaining space and wrap to their own row when needed. At narrow widths make the explorer collapsible and details an overlay so the action group remains reachable. Do not move the action group below the gauges. |
| UX-09 | Explorer search matches networks, hostnames and IPs and filters the work surface. Table search further narrows it. Never claim a page-local search covers the entire subnet. |
| UX-10 | Preserve header service/stat interactions and user preferences. Do not restore decorative left stripes on system-stat cards. |
| UX-11 | During rollout retain the Current interface / Workspace concept switch. Keep presentation files separated, while sharing API transport, canonical cell formatting and pure domain utilities. |
| UX-12 | A database mutation and DNS/DHCP configuration application are different outcomes. Show saved/pending/applied/failed truthfully. A toast alone is insufficient for persistent apply failures. |

## 3. Information architecture and navigation

### 3.1 Context matrix

| Selected context | Central views | Create menu | Actions menu | Detail panel |
| --- | --- | --- | --- | --- |
| All Networks | Networks, DNS zones, DHCP scopes | Allocate network, Add address space, Add folder, Add DNS zone, Add DHCP scope | Manage folders, Browse unallocated, DNS apply, DHCP apply, Sync leases, contextual settings links | Network, zone or scope summary with Open and Edit |
| Folder | Networks, associated DNS zones, scopes on member networks | Same entries with folder/network defaults | Edit folder, Delete folder, bulk network actions, defaults link | Selected resource, independent of folder row selection |
| Allocated leaf network | Addresses, DNS records, DHCP addresses/reservations/leases, Ranges | IP Reservation, DHCP Reservation, DNS record, DHCP scope, organizational range | Edit network, Divide/carve, Merge, Move to folder, Apply name template, Deallocate, Scan history, settings links | Address, DNS record, scope/reservation or range |
| Unallocated address space | Hierarchy/leaf table in an Unallocated mode of the same surface | Add address space, Allocate selected leaf | Divide/carve, merge eligible siblings, delete eligible space | CIDR, hierarchy, usable capacity and allocation action |
| Zone drill-in from aggregate | Records of that zone with breadcrumb back to aggregate DNS | DNS record | Edit zone, Delete zone, DNS apply | DNS record details |
| Scope drill-in from aggregate | Scope address rows with breadcrumb back to aggregate DHCP | DHCP Reservation | Edit/disable/delete scope, Sync leases, DHCP apply | DHCP row/address details |

Zone and scope drill-ins are subordinate resource views, not new global explorer modes. Store their IDs separately from the All Networks/folder/network context. A scope's Open network action explicitly changes network context. A zone may span multiple networks or none, so do not select an arbitrary network when opening it.

### 3.2 Shared-zone rules

- All Networks DNS lists every permitted zone, including unlinked zones, exactly once.
- Folder DNS lists zones associated with at least one member network, with all matching network associations available in details. A shared zone is one row, not one duplicate per network.
- Network DNS initially shows records related to that network. A zone filter narrows this set.
- Add **View entire zone** when a zone is shared or has non-address records. It opens zone drill-in and visibly states that the zone is shared and which context the operator came from.
- A/AAAA membership uses canonical address/network association. PTR uses the address represented by the reverse owner. CNAME membership follows a resolvable canonical target using server-owned relationships. MX/TXT/SRV with no address association remain available in whole-zone view, not silently attributed to every network sharing the domain.
- Editing or deleting a shared zone discloses that all its records and linked networks are affected. A context filter never changes mutation scope.

### 3.3 URL and state contract

Implement a workspace-only route codec. Query keys are `context=all|folder|network|unallocated`, `folder`, `network`, `view=networks|addresses|dns|dhcp|ranges`, optional `zone`, `scope`, `ip`, `presentation=table|grid|compact`, `q`, `tableQ`, `page` and `pageSize`. Serialize only non-default values. IDs are validated positive integers. An IP deep link also identifies its network, and scoped IPv6 identity additionally requires interface context if supported by the endpoint.

- URL wins over saved state. Saved state wins over All Networks / Networks defaults.
- Browser Back/Forward restores context, view, filters and open details. Typing search uses replace, selecting a context/drill-in uses push.
- Keep storage namespaced per user and workspace version. Migrate the existing font preference read-once. Never overwrite current-interface preferences.
- A deleted resource yields an explicit no-longer-exists message and nearest surviving parent context. A stale saved ID must not select the first unrelated resource.
- Capture mutation target IDs when opening a form. Changes to the explorer behind a form cannot retarget Save.
- Page/filter/view changes clear bulk selection with an accessible count update. Details remain pinned across related-resource navigation and background refresh. Explicit selection of an unrelated network clears details after resolving unsaved changes.

## 4. Baseline gaps and required treatment

`Live` below means an API binding exists in source, not that every edge case has been verified.

| Surface | Baseline | Required work IDs |
| --- | --- | --- |
| Explorer and aggregate inventory | Live tree/zones/scopes, allocated networks flattened | W-01, W-02, N-01 through N-04 |
| Network address table/pagination/sort | Live paginated `/subnets/:id/ips` | W-03, B-02, B-03 |
| Grid and compact grid | Live page rows, basic inspection | W-04, A-02, R-02 |
| Explorer/table search | Partial, mixed local/server search, one query can win over the other | B-02, W-03 |
| Column chooser and state filter | Chooser placeholder, state button cycles a few presets | W-03 |
| Network create/edit/divide/merge and folder actions | Preview notices | N-01 through N-10 |
| Individual IP Reservation create/release | Live in new address panel | A-01, W-05 validation and unified entry points |
| IP scan override and probe | Live in new address panel | A-04, A-05 validation and unified entry points |
| Network Scan now | Preview notice | N-09 |
| Lifecycle panel | Live events, smaller local label map | A-06, A-07 |
| DNS zone/record displays | Live, initial all-zone record fan-out | D-01 through D-06, B-02 |
| DHCP scope/address displays | Live, source data merged locally | H-01 through H-07, B-02 |
| Scope chips, ranges, bulk operations, generic row actions | Mostly notices | H-01, R-01 through R-03, W-05 |
| Apply, sync, full activity | Missing/placeholder in preview | O-01, A-06, S-10 |
| Other application pages | Functional existing pages, separate anomaly live/sample preview | Section 10 |

Do not carry these implementation defects into the new handlers:

- `loadWorkspace()` combines all protocol loads in one `Promise.all`. A DNS-only or DHCP-only role can lose the entire workspace when the other domain returns 403.
- `loadNetworkContext()` couples address success to every scope-address request. Give each resource independent loading/error state.
- `refreshSelectedNetwork()` refreshes tree/IP data but not all DNS/DHCP resources changed by lifecycle writes. Use section 7.
- `changePage()` and some view switches discard the details object. Preserve resource identity rather than a reference to a page row.
- Existing `useSubnetStore().divideSubnet()` obtains another preview immediately before execution. The new transformation action must execute the token the operator actually reviewed.
- Existing pool-removal code deletes or edits range rows directly even when a scope owns them. The server rejects attached-range deletion. Route scope changes through the DHCP owner and disclose dependent cleanup.
- Existing DNS editor includes a warning that static DNS inside a pool may be reassigned. That conflicts with canonical exclusion rules. Use server rejection/exclusion outcomes, not that warning text.
- Scope responses expose `pools[]`; top-level start/end may describe only the first pool. Never collapse multiple pools into one continuous interval.
- Existing updater check-enabled code calls `PUT /settings`, which is not a declared route. When porting it use the supported settings-key/bulk contract and test the exact request.

## 5. Component and code ownership

Do not enlarge the preview monolith with every editor. Extract its existing presentation before layering in mutations. Proposed paths below are new unless marked existing. File names are the implementation targets, not an instruction to create empty scaffolding for every file at once.

```text
client/src/views/networks-workspace/
  NetworksWorkspace.vue                            context orchestration only
  ResourceExplorer.vue                             folders, leaves, search, browse mode
  WorkspaceContextHeader.vue                       breadcrumb, gauges, pinned actions
  WorkspaceToolbar.vue                             search, filters, columns, presentation
  WorkspaceTable.vue                               table rendering, sort, selection, paging
  AddressGrid.vue                                  spacious and compact density props
  WorkspaceDetailsHost.vue                         stable resource identity and panel switch
  AddressDetailsPanel.vue                          existing, extend rather than replace
  NetworkDetailsPanel.vue
  DnsDetailsPanel.vue
  DhcpDetailsPanel.vue
  RangeDetailsPanel.vue
  WorkspaceActivityPanel.vue
  ConfigurationApplyStatus.vue
  dialogs/
    FolderEditor.vue
    NetworkEditor.vue
    NetworkTransformDialog.vue                     divide/carve/merge with exact plan
    NetworkDeleteDialog.vue
    IpReservationEditor.vue
    DnsZoneEditor.vue
    DnsRecordEditor.vue
    DhcpScopeEditor.vue
    DhcpReservationEditor.vue
    RangeEditor.vue
    BulkActionDialog.vue
  composables/
    useWorkspaceContext.js                        route/state codec and restoration
    useWorkspaceResources.js                      reads, cancellation, freshness
    useWorkspaceActions.js                        commands and invalidation
    useWorkspaceSelection.js                      identity sets, contiguous runs
  workspace-actions.js                            registry of action IDs/eligibility
  workspace-columns.js                            reuse canonical catalog, view additions
  workspace.css                                   scoped visual tokens and layout
client/src/views/networks-workspace-data.js          existing pure display adapters
client/src/composables/usePermissions.js            server-supplied capabilities
client/src/components/workspace/                    shared chrome only after second consumer
```

Keep existing `NetworkDialogs.vue`, `DnsPanel.vue`, `DhcpPanel.vue` and `SubnetDetail.vue` as parity references and current-interface implementations. New components may reuse the API client, stores where safe, `ipTableColumns.js`, `IpTableCell.vue`, `ipLifecycleDisplay.js`, date format, storage and validation helpers. Do not embed the old three-panel layout inside the workspace or add `isPreview` branches throughout old files.

Use `client/src/ui/*` for vendor widgets, services and theme APIs. No direct OpenVue/PrimeVue imports outside that seam. Extract shared pure form/payload logic when needed by both versions, with tests for both callers. Do not share mutable selections or dialog refs between interfaces.

`ipLifecycleDisplay.js` currently formats canonical status/type, not event history labels. Add a small shared `client/src/utils/ipLifecycleEvents.js` for the event label/tone/detail formatting currently duplicated in the two detail components. Port their union of supported event labels, preserve unknown-event fallback, and test Metadata Expired and scope-membership event rendering. Do not introduce a new allocation-state policy in that helper.

Each action registry entry has a stable `id`, label, required capability, target kind, availability predicate, disabled reason and handler. Header menus, table menus, grid menus, details quick actions and keyboard invocation call the same handler with an immutable target object. Example IDs: `network.edit`, `network.divide`, `ip.reserve`, `ip.release`, `dns.record.edit`, `dhcp.reservation.create`. Display labels are never used as dispatch keys.

## 6. API prerequisites and additive contracts

All endpoint paths below include `/api`. Calls through `client/src/api/client.js` omit that prefix. Existing endpoints retain their current responses for old callers. New/extended endpoints below are proposals and must be implemented and tested before dependent UI work is marked complete. Do not send proposed parameters to an unchanged route and assume they work.

### B-01. Permission-aware loading and actions

Owner: `server/src/auth/routes.js`, `server/src/auth/roles.js`, auth response tests, `stores/auth.js`, `usePermissions.js`.

Add `permissions: string[]` and `is_admin: boolean` to the user response from login, `/auth/me` and change-password using the existing server role authority. Do not mirror the role table in the client or fetch admin-only `/users/roles` to initialize the workspace. No role grants change.

Until capabilities load, show loading/read-only affordances and do not launch protected protocol requests. A DNS admin can use Networks and DNS without attempting DHCP reads. A DHCP admin has the symmetric experience. Read-only users get inspection, search and copy, with no write controls. The server still authorizes every call. A 403 refreshes capability state and explains that access changed without clearing unrelated successful data.

### B-02. Complete, permission-scoped search and protocol reads

Owner: new `server/src/routes/workspace.js`, new read-only `server/src/models/workspace-view.js`, mount in `server/src/index.js`, route/read-model tests. Reuse `ip-view` and DNS/DHCP read helpers. Extract reusable read helpers from existing routes if necessary. No direct lifecycle writes here.

Add these read endpoints to avoid fetching every record from every zone on entry:

| Proposed route | Permission | Query and response |
| --- | --- | --- |
| `GET /workspace/networks` | `subnets:read` | Optional `folder_id`, `q`. Return `{items, total}` with existing network fields, only allocated leaves matching network name/CIDR/VLAN/domain or canonical hostname/IP. Do not expose protocol facts beyond existing canonical IP reads. Empty folders remain available from `/subnets`. |
| `GET /workspace/dns-records` | `dns:read` | Optional `subnet_id`, `folder_id`, `zone_id`, `q`, `table_q`, `record_type`, `dns_source`, `enabled`; `page=1`, `page_size=50` (1–256), `sort_field`, `sort_order=asc|desc`. Return `{items,total,page,page_size}`. Items retain full canonical DNS/IP projections and add `related_subnet_ids`. Apply membership rules in 3.2. No caller-supplied SQL sort expressions. |
| `GET /workspace/dhcp-addresses` | `dhcp:read` | Optional `subnet_id`, `folder_id`, `scope_id`, `q`, `table_q`, `lease_status`, `dhcp_assignment_type`; same paging/sort envelope. Return existing explicit DHCP/IP projection plus stable protocol IDs. Include reservations outside a dynamic pool in network view. Scope view is limited to that scope, and includes unavailable/free rows through existing scope-address projection. |

Filter semantics: context constraints and filters are ANDed; each free-text query matches any searchable field by case-insensitive literal substring. `%` and `_` are literal input, not SQL wildcards. `q` and `table_q` both apply. Canonical IP parsing supports exact-IP lookup, and numeric address sorting uses canonical keys. Every sort has a stable ID tiebreaker. A valid but missing context returns 404, malformed values 400, unauthorized protocol reads 403.

Extend `GET /dns/zones` additively with `related_subnet_ids` and `related_networks` (ID/CIDR/name only, visible through `subnets:read`). These associations use the same read helper as network DNS filtering, so the client does not infer relationships with domain-string suffix tests. Global zones stay visible even without a relationship. Add optional `folder_id`, `subnet_id`, `q`, `table_q`, `type` and `enabled` filters while retaining the array response. A hostname/IP query matches a zone through matching records as well as the zone's own fields. Aggregate DNS must not ignore hostname/IP search just because its rows are zones.

Extend `GET /dhcp/scopes` with optional `folder_id`, `subnet_id`, `q`, `table_q` and `enabled` filters, retaining the array response. Hostname/IP queries match scope members and contained unused IPs as well as network/scope fields. Use actual pool intervals for containment. Network inventory table search adds `table_q` to `/workspace/networks` with the same AND semantics. Explorer search alone uses `q` and must not inherit a hidden stale table filter from another view.

Relationship resolution is a read of managed data, never a live DNS lookup. Bound CNAME traversal, detect cycles and unresolved/out-of-estate targets, and leave those records available in whole-zone view. A query must not trigger DNS traffic or mutate learned metadata.

Search does not materialize every IP in a prefix. For exact address search, include a containing allocated network even if the IP has no stored row. Hostname matches use canonical metadata and allowed protocol projections. Queries produce correct results before pagination. Test a hostname whose row is beyond the first `/22` address page.

### B-03. Address query, details and summary completeness

Owner: `server/src/routes/subnets.js`, `server/src/models/ip-view.js` or a read-only subnet view helper, existing IP read tests.

- Extend `/subnets/:id/ips` with separate `table_search` in addition to existing `search`, and explicit `display_status`, `address_type`, `online`, `range_type_id`, `scanning_enabled` filters. Existing `page`, `pageSize`, `showAvailable`, `sortField`, `sortOrder` remain compatible. Apply all filters before paging, retain existing fields and add `filteredTotal` so total subnet size is not confused with result count.
- Add `GET /subnets/:id/ips/:ip` (`subnets:read`) returning `{ip: <canonical IP projection>}` including a canonical available row when appropriate. It is a read, creates no persisted assignment/event and verifies containment. It lets a pinned drawer refresh independently of its old page. Reuse the same virtual-row projection as the list. Encode address path segments with `encodeURIComponent`; do not use display text or a protocol record ID as address identity.
- Add `GET /subnets/:id/summary` (`subnets:read`) returning `{subnet_id,total_addresses,assigned_count,unassigned_count,online_count,rogue_count}` from canonical definitions, not current-page rows. Protocol counts continue to come from protocol-permitted inventory endpoints. Do not expose DHCP-only/DNS-only details through this route.
- Summary assigned/unassigned partition the address total. Pool membership overlaps allocation and is displayed as a separate gauge/overlay, never a third disjoint slice of the same bar.
- The current network browsing/probe/bulk APIs are IPv4-oriented. Preserve canonical IPv6 facts on supported DNS/IP rows, but do not offer unsupported IPv6 network allocation, scan or full-prefix grids. New-family workflow support is a separate backend scope, not a pretend UI control.

### B-04. Authoritative creation defaults

Add `POST /subnets/configuration-preview` (`subnets:read`) before parameterized routes. Body: `{cidr, gateway_policy?, gateway_address?}`. Return normalized CIDR, resolved gateway policy/address, suggested network name, and `default_dhcp_pool: {start_ip,end_ip}|null`, plus explanation if no pool fits. Read the current defaults and call existing server name/gateway/default-pool helpers, especially `defaultDhcpPoolForSubnet` in `subnet-dhcp-topology.js`. No database mutation or scan.

Network and scope editors use this preview when offering defaults. Existing transformations already return authoritative target intervals and must use those instead. Do not introduce a second hardcoded DHCP sizing formula in the workspace. Changes to CIDR/gateway invalidate the suggestion and display the revised pool before Save. Explicitly edited pool bounds remain operator-owned and are validated by the write route.

### B-05. Audit scoping and apply diagnostics

Extend admin-only `GET /audit` with optional `entity_id` paired with `entity_type`; filter before pagination. Keep existing action/entity/user filters and response shape. Full IP history remains `/subnets/:id/ips/:ip/events`, not a client filter of the first audit page. A network activity panel must label exact-entity audit entries separately from IP lifecycle events, and must not claim to aggregate every descendant event without a supported server query.

Use existing `/metrics/configuration-generation` for global apply status (`analytics:read`). Preserve desired/applied generation and errors from its actual projection. Existing `/dns/apply` and `/dhcp/apply` are explicit apply actions gated by their write permissions. Do not claim either retries a durable failed job until a test establishes that behavior. If that is missing, add an explicit service-backed retry action as a prerequisite to displaying Retry, using the existing generation owner, with no direct config-file writes in the UI route.

## 7. Mutation and refresh contract

Every handler follows: capture target → load necessary defaults/current resource → edit → validate → confirm impact if destructive/transforming → submit once → show actual result → invalidate affected reads → refresh visible consumers → retain context and details identity.

| Mutation | Invalidate/refetch |
| --- | --- |
| Folder name/move/delete | Tree, network inventory, association labels, saved context validation |
| Create/configure/edit/delete/divide/merge network | Tree, all affected network IP pages/details/summaries, ranges, zones/records, scopes/addresses/reservations, configuration status |
| IP Reservation create/release | IP pages/detail/lifecycle, summary, DHCP address availability, scope counts, header stats |
| DNS record/zone change | Zones/records/associations, affected IP pages/detail/lifecycle/summary, related DHCP availability, configuration status |
| DHCP scope/pool change | Scopes/pools/addresses/leases, ranges, IP pages/detail/lifecycle/summary, configuration status |
| DHCP Reservation create/edit/delete/enable | Reservations, leases/unified addresses, IP pages/detail/lifecycle/summary, DNS A/PTR/zone counts, configuration status |
| Probe/scan/lease sync | Scan state, IP pages/detail/lifecycle/summary, DHCP rows and DNS projections affected by lease sync, header stats |
| Range type/tag change | Ranges, canonical IP range metadata, columns/filters/detail, type catalog where edited |
| Device override/reset | Fingerprint, fingerprint history, IP/DNS/DHCP device columns, open anomaly details if present |

Use keyed requests and cancellation/request-generation guards. Late responses for network A cannot replace network B. Refresh old-interface subnet caches through `invalidateDetailCache` when sharing stores and retain `ipam:stats-changed` where existing global consumers depend on it. Do not reset the workspace to All Networks after every mutation.

Disable duplicate submission, preserve fields on 400/409/network failures, and give a retry control for read failures. If Save succeeded but the follow-up read failed, say **Saved; refresh failed** and offer refresh, not another Save. Do not automatically replay a write after a timeout. For sequential multi-resource operations keep a per-target ledger, stop on failure, and offer retry of failed/not-started targets only.

## 8. Network, address and range work packages

In the tables, **Test** is the minimum behavioral acceptance case, in addition to section 12. API values and disabled reasons must come from current server contracts. Each listed UI entry point uses the shared action registry.

### Network management

| ID | Entry and editor behavior | API sequence and outcome | Test |
| --- | --- | --- | --- |
| N-01 | Explorer Manage folders or Create folder opens folder list/editor. Fields name, description. Row menu Edit/Delete. | `GET/POST /folders`, `PUT/DELETE /folders/:id`. Deletion ungroups contained networks without deleting them. Explain this before confirmation. Refresh folder labels and context. | Rename selected folder; delete empty/nonempty folder and retain networks under Ungrouped; duplicate names remain distinct by ID. |
| N-02 | Browse unallocated switches the center to hierarchy/leaf view. Expand parents, select leaves, allocate via explicit button or keyboard. | `/subnets` hierarchy. Fully subdivided unallocated parents are containers, never selectable free space. Preserve a path to partially free descendants. | Split fully allocated `/24`, browse free space, parent is not offered as an allocatable `/24`. |
| N-03 | Add address space form: CIDR, optional name/description/VLAN/folder. | `POST /subnets {cidr,name,description,vlan_id,folder_id}` creates address space. Do not call configure unless Allocate was requested. Show normalized CIDR and overlap errors. | Add root, reject overlap, retain form and server message; creation does not run a scan. |
| N-04 | Allocate network, from Create or unallocated leaf. Fields name/template preview, description, folder, VLAN, domain, gateway policy/custom IP, scan enable/inherit and interval, reverse-DNS toggle, Create DHCP Scope toggle and displayed default/editable bounds. | New root uses POST `/subnets`, then POST `/:id/configure`; existing leaf only configure. Body fields in 8.1. Track created ID so configuration retry does not duplicate the root. | Two-step second-call failure leaves a clearly named unallocated resource with Resume configuration. Defaults and explicit pool edits are retained correctly. |
| N-05 | Edit from explorer menu, network inventory row, folder row, header or details opens same NetworkEditor with captured ID. | GET `/subnets/:id`, PUT same path with edited fields, no create-only flags. Inline Add VLAN/zone/folder uses each resource's API and returns selection to the original form. | Edit a folder-list row while no tree node is selected. Save updates that ID without null `.data` access. |
| N-06 | Divide/carve dialog: Equal division or Specific CIDR, child selection, target gateway policy overrides, target preview table, conflict/cleanup disclosure. | POST `/:id/divide/preview`, then `/:id/divide` with reviewed token. See 8.2. | Exact reviewed token, stale preview, source scope → default pool on both children, no synthetic rogues. |
| N-07 | Merge selected siblings from table/Unallocated mode; show source networks, resulting CIDR, gateway policy, scope pool and conflicts. | POST `/subnets/merge/preview {subnet_ids}`, then `/subnets/merge {subnet_ids,plan_token,plan_id}`. Conflict requires source correction then re-preview when API has no merge-resolution field. | Opposite selection orders produce same result; policy conflicts do not silently choose first child. |
| N-08 | Move to folder through row menu and drag/drop. Apply name template through row or bulk Actions. Group allocate from unallocated selection. | PUT `/subnets/:id {folder_id}`, POST `/subnets/apply-template {subnet_ids}`, per-leaf configure for group allocate. No invented bulk endpoint. | Drag and menu yield same target; bulk partial failures report exact completed and remaining IDs. |
| N-09 | Scan now starts scan in context. Actions → Scan history opens run list and detail/results, delete old run where allowed. Show last scan/next schedule and progress. | POST `/scans {subnet_id}`, GET `/scans?subnet_id`, `/scans/:id`, `/scans/next`, DELETE `/scans/:id`. 409 `scan_id` opens existing run; poll using established scan behavior and stop at terminal state/unmount. | Duplicate start, failed run, too-large network, scan completion refresh. Viewing public address space never starts a probe. |
| N-10 | Deallocate allocated network vs Delete address space vs Delete descendants are distinct labels and confirmations. Show CIDR, descendant count and dependent configuration being removed. | All currently use DELETE `/subnets/:id`; render response `action`, not the menu label, as actual outcome. Allocated nodes deallocate and may remove descendants; unallocated roots delete their subtree; unallocated nonroot parents delete descendants; leaves delete/consolidate. Use the current service behavior, never assume a parent delete will be rejected. | Each service branch has an impact confirmation and result test, including subtree deletion and buddy consolidation; selection resolves after consolidation. |

#### 8.1 Network editor payload

Configuration fields: `name`, `description`, `vlan_id`, `folder_id`, `domain_name`, `gateway_policy`, `gateway_address`, `scan_enabled`, `scan_interval`, `create_reverse_dns`, `create_dhcp_scope`, `dhcp_start_ip`, `dhcp_end_ip`. Send scan override as boolean/null. Preserve gateway intent `first|last|custom|none`; never infer it from the resolved literal IP on edit. Name is required on configure. Editing strips creation flags and only sends supported update fields. CIDR changes use existing update validation and impact rules, not a browser-only relabel.

VLAN lookup uses `/vlans/search?q=` and creation `/vlans`. Forward zone selection uses `/dns/zones`, creation uses D-01. A shared VLAN warning must be visible before applying the assignment. Canceling the parent form must not silently delete independently created shared resources. Explain any resources already created during a multi-step operation.

#### 8.2 Transformation contract

1. Capture source IDs and fetch preview with current parameters. Divide accepts `new_prefix` or `cidr`, optional `selected_cidrs`, `target_gateways`.
2. Render the canonical `plan`: source/target CIDRs, gateway intent and resolved address, each target's explicit DHCP intervals and origin, inherited policy, rehomed resources, exact conflicts and destructive cleanup. Legacy top-level summary fields must not override the plan.
3. Explain before confirmation: if any source has a scope, every supported target gets a scope with the standard-sized interval shown. With no source scope, none is created. Pool presence does not assign IPs and old pool bounds are not preserved.
4. Changing source selection, prefix, carve CIDR or gateway overrides invalidates confirmation and refetches. Do not execute while preview is loading or invalid.
5. Execute the same immutable parameters with `plan_token=plan.dependency_token`, `plan_id=plan.plan_id`. Divide sets `force` only after the allocated-network impact is accepted. Exact `conflict_resolutions` may include only records returned by the current supported conflict flow. Never offer blanket force as a policy-conflict bypass.
6. On `409 stale_plan`, replace displayed preview, clear prior confirmations/resolutions, and require a new review. Do not automatically submit the replacement token.
7. On success select returned surviving target identity or show resulting targets in the folder context. Re-fetch topology and protocol projections. Show durable config apply status separately.

### Addresses and details

| ID | Entry and required behavior | API/owner | Test |
| --- | --- | --- | --- |
| A-01 | Reserve/release from table, either grid, toolbar and details. Explicit name **IP Reservation**. Note required by workspace create form. Release confirms the hold, not a DHCP lease. | PUT `/subnets/:id/ips/:ip/allocation {allocation_state:'reserved',note}` or `{allocation_state:'unassigned'}`. Availability is based on canonical allocation state; server final authority. | All entry points produce identical payload/state. Scope member returns to server-projected DHCP Scope after release. Static DNS/DHCP/system/gateway cannot be cleared through generic release. |
| A-02 | Bulk reserve/release. Show selected count and exact contiguous runs, with no implicit inclusion of gaps. Same selection in both grids and table. | PUT `/subnets/:id/ips/bulk-allocation {start_ip,end_ip,allocation_state,note}` per run; chunk at no more than 1024 addresses. Show response updated/skipped counts; stop and report partial completion on error. | Disjoint selections do not reserve intervening IPs; topology skips are disclosed; later-run failure does not replay completed runs. |
| A-03 | Create/edit/delete DHCP Reservation and DNS record from an address. Prefill IP/MAC/hostname, choose owning network/zone explicitly when ambiguous. | Delegate to H-04/D-02 handlers, never allocation-state writes. | Gateway can be named by supported DNS action without allocation changing; static-DHCP editing uses reservation ID, not IP-row ID. |
| A-04 | Scan controls Inherit / On / Off. Display override and server effective result separately. | PUT `/subnets/:id/ips/:ip/scan-enabled {scan_enabled:null|true|false}`; GET projection uses `scanning_enabled`. Normalize 0/1 only at read adapter. | Inherit remains null; inherited public-network scan protection is not reconstructed or bypassed. |
| A-05 | Probe now action with in-flight indicator and result. | POST `/scans/probe {ip,subnet_id}`. Reuse scan result/status vocabulary; no fake online success. | Offline, timeout, 403 and unsupported address family remain distinct from success. |
| A-06 | Detail tabs Overview / Lifecycle / Device. Lifecycle shows available actor/source/time/old/new values and clear empty/error states. Default fetch is latest 100; expanded history requests `limit=500` and is labeled Latest 500, not complete history. | GET `/subnets/:id/ips/:ip/events`; reuse `ipLifecycleDisplay.js` and date preferences. **Metadata Expired** for `retired`. Render recorded scope membership events without manufacturing allocation events. No invented actor when event projection lacks one. | Scope-only unused address can show Metadata Expired in history while current status remains DHCP Scope; related buttons keep panel open. |
| A-07 | Device facts: MAC/vendor, device/OS/confidence, fingerprint/vendor class/source/hostname and change history. Reset to detected and manual override editor where permitted. | GET/PUT/DELETE `/devices/:mac/fingerprint`, GET `/devices/:mac/fingerprint/history?days=90`, `dhcp:read/write`. PUT `{device_type,os_family}`, each null or string of at most 64 characters. No MAC means no device request. | Manual override stays authoritative until reset, history preserved, DNS-only role still sees canonical address details when device lookup is forbidden. |
| A-08 | Copy address/hostname/MAC, open network, related DNS/DHCP and full details from any protocol row. | Stable composite identity with canonical raw data. Use B-03 for fresh address, B-02 for related rows. Clipboard is local UI only. | A non-address DNS row does not open a fabricated IP; changing tabs does not retarget an open action. |

### Ranges and gateway interaction

| ID | Entry and required behavior | API/owner | Test |
| --- | --- | --- | --- |
| R-01 | Ranges view includes organizational ranges plus clearly labeled projected system/gateway/DHCP ranges. Add/edit form: range type, start/end, description. | GET/POST `/subnets/:id/ranges`, PUT/DELETE `.../ranges/:rangeId`. Type catalog `/range-types`. System rows have no generic delete; gateway action opens NetworkEditor. | Range-tag edit does not change allocation, online state, DNS, DHCP or scan policy. |
| R-02 | Set range type from address selection. Show overlap impact before replacement and keep selected runs exact. | PUT `/subnets/:id/ranges/set-type {range_type_id,ranges,accept_overlaps}`. Reuse existing selection object shape in `selectedIpRuns` and server handler. Retry with `accept_overlaps:true` only after reviewing current overlap response. | Adjacent/disjoint runs, existing tag overlap, declined confirmation, immutable topology rows. |
| R-03 | Scope ranges route Edit/Delete/Trim to DHCP handlers. Start/end trimming allowed for single writable pool; whole selection invokes Delete scope confirmation. Middle removal is not offered as a working operation until pool-interval editing API exists. | H-02/H-03; never bypass attached-scope range protection. If deleting scope leaves an unused range, offer explicit separate R-01 deletion after refresh. | Attached range cannot become an invisible orphan; middle removal gives precise unsupported-operation guidance without pretending only one scope per subnet is universally supported. |

## 9. DNS and DHCP work packages

### DNS

| ID | UI placement and behavior | API and payload | Test |
| --- | --- | --- | --- |
| D-01 | Aggregate DNS zone inventory with Forward/Reverse/All filters. Zone detail and editor. Fields name, type, description, enabled and SOA fields. | GET `/dns/zones`, `/dns/zones/:id`, `/dns/soa-defaults`; POST `/dns/zones`, PUT/DELETE `/dns/zones/:id`. SOA: `soa_primary_ns`, `soa_admin_email`, `soa_refresh`, `soa_retry`, `soa_expire`, `soa_minimum_ttl`. | Server defaults unavailable → retry, never invented defaults. Shared zone edit/delete impact visible; reverse records remain accessible. |
| D-02 | Record editor from network DNS, whole-zone table, address detail or Create menu. Zone picker only when not predetermined. | POST `/dns/zones/:zoneId/records`, PUT same plus `/:id`. Body `name,type,value,priority,weight,port,ttl,enabled`; read `record_type` maps to write `type` at form boundary only. | Create/edit A, AAAA, CNAME, PTR, MX, TXT, SRV; numeric zero vs null retained; bad hostname/IP/TTL errors stay in form. |
| D-03 | Row toggle/enable, Delete confirmation and details quick actions use same record handler. | PUT existing record path with enabled change; DELETE same. Preserve record/zone IDs even when context changes. | DNS disable/delete causes correct canonical allocation and PTR refresh, and does not erase DHCP ownership. |
| D-04 | Generated records show Source, owner relationship and controlled actions. Placeholder PTRs remain inspectable; supported manual override is explicit. | `dns_source`, `record_fqdn`, canonical IP fields. Observe existing record-route safeguards. Generated records may be recreated by reconciliation; explain and link to owning reservation/network rather than promise permanent deletion. | Static/manual PTR overrides survive rename/reconcile; generated PTR hostname converges after DHCP reservation rename/delete. |
| D-05 | DNS filter/columns include RR type, enabled, source and zone. Whole-zone view shows non-address records. Probe only for supported associated IPs. | B-02 reads, A-05 probe, `/dns/resolve?name=` for existing hostname-resolution helper. Never invent network association by string shape. | Shared forward zone, reverse zone, unlinked zone, aliases, non-address records and off-page match. |
| D-06 | Context Actions offers Apply DNS configuration. Service settings link opens Settings → DNS and preserves workspace return URL. | POST `/dns/apply`; O-01 apply status. Forwarders/encryption/DNSSEC/SOA defaults remain global settings, S-03. | Save vs apply distinction; disabled DNS service and apply failure are visible, not an empty-success table. |

Use conditional record fields: A/AAAA address value; CNAME/PTR hostname target; MX preference via priority; TXT literal value; SRV priority/weight/port/target. Keep TTL inheritance distinguishable from an explicit TTL. Reuse existing canonical cell formatting for FQDN, reverse owners and missing values. Do not truncate editable TXT data to the compact table display length.

### DHCP

| ID | UI placement and behavior | API and payload | Test |
| --- | --- | --- | --- |
| H-01 | Aggregate scope inventory, network scope chips and scope drill-in. Show network, every pool interval, enabled, lease time, utilization/availability and description. | GET `/dhcp/scopes` including `pools`, `options`, `effective`; B-02 addresses; existing `/dhcp/scopes/:id/addresses` remains available. Scope chip opens details/drill-in, not a notice. | Multiple scopes and multi-pool read rows do not duplicate reservations or imply gap addresses are leased/available. |
| H-02 | Create scope with network locked in network context, selectable in aggregate context. Choose unused DHCP range or enter bounds with server-suggested default. Edit lease duration, description, enabled and options. | GET `/dhcp/available-ranges`, `/dhcp/options`, B-04. For new bounds POST `/subnets/:id/ranges {range_type_id,start_ip,end_ip,description}`, then POST `/dhcp/scopes {subnet_id,range_id,lease_time,description,enabled,options}`. Options are `{code,value}` entries. Track created range ID for retry. New-range path requires both `subnets:write` and `dhcp:write`; a DHCP-only admin can select an existing eligible range but cannot create a range through this flow. Show that restriction, do not loosen route authorization. | Failure on second call resumes existing range; no duplicate scope/range. Domain/gateway/DNS option inheritance uses effective server fields. Test both permission paths. |
| H-03 | Edit/disable/delete scope from inventory, chip, range, detail and Actions. Pool trim uses same editor. Delete discloses dynamic pool removal separately from existing leases/reservations. | PUT `/dhcp/scopes/:id {start_ip,end_ip,lease_time,description,enabled,options}`, DELETE same. Existing write API is single-interval oriented; show all pools but disable lossy multi-pool boundary editing with reason until explicit interval API is designed. | Gateway/system/static conflict, stale scope, disabling/re-enabling, deletion with leases/reservations match server. Multi-pool edit never drops all but first interval. |
| H-04 | DHCP Reservation editor fields network, IP, MAC, hostname, description, enabled. Convert dynamic lease prefills client/IP, with conflict disclosure. | POST `/dhcp/reservations {subnet_id,mac_address,ip_address,hostname,description,enabled}`, PUT/DELETE `/dhcp/reservations/:id`. Use `reservation_id` from unified rows. | Valid MAC formatting/paste, duplicate client/IP, static DNS/IP hold/topology conflicts, reservation outside pool, dynamic-to-static same client. |
| H-05 | DHCP table filters Lease status and Assignment separately from canonical IP Status/Type. Detail includes expiry, hostname, client identity and source. | B-02, `/dhcp/leases`, `/dhcp/reservations?subnet_id=`. `dhcp_assignment_type`, `lease_status`, `expires_at` are explicit protocol fields. | DHCP Scope is availability, not a lease/allocation. Unavailable pool address is not offered as free. Infinite/expired/offline rows render correctly. |
| H-06 | Sync leases and Apply DHCP in context Actions, with feedback that the operation affects the appliance globally. | POST `/dhcp/sync-leases`, POST `/dhcp/apply`, O-01. Sync refreshes all affected protocol/IP views. | Sync failure does not clear rows. Completed sync refreshes hostname/PTR and lease status, not only active tab. |
| H-07 | Scope Options section grouped by option catalog, inherited vs explicit values, reset-to-inherit and help. Global defaults/custom option definition link to Settings → DHCP. | GET `/dhcp/options`; per-scope `options:[{code,value}]`; S-04 owns `/options/defaults` and `/options/custom`. `lease_time` is sole duration authority, never duplicate option 51 control. | Clearing explicit option restores effective inherited value; zero/false/string list values retain meaning; changed global defaults do not overwrite explicit scope settings. |

Missing capabilities must remain explicit: current reservation create/probe routes validate IPv4/MAC and are not a complete DHCPv6 editor. Do not offer DUID/IAID mutation controls merely because those read fields exist. Full multi-pool writes are a backend extension, not required to preserve existing supported single-pool editing, but accurate multi-pool inspection is mandatory.

## 10. Application-wide parity map

These packages apply the workspace visual language without forcing every screen into a network context. Retain current route/bookmark behavior during migration. New presentation files live under `views/settings-workspace/`, `views/analytics-workspace/` and `views/account-workspace/`; use existing stores and established model/service APIs. A global configuration editor is labeled **Appliance-wide** when opened from a network.

Every package includes its existing load/error/empty/busy states, field validation, confirmation and current `data-track` attributes. Use shared workspace chrome only where there are at least two real consumers. API route coverage, including supporting read endpoints, is enumerated in Appendix A.

| ID | Existing source and destination | Required fields/actions and API mapping | Acceptance |
| --- | --- | --- | --- |
| S-01 | `NetworkSettings.vue` → Settings / General / Naming & Scanning | Name template and live example, default scan toggle/interval, history retention, manual scan target/run. GET `/settings`, PUT `/settings/bulk {settings:{...}}`, `/scans`. Custom range type CRUD `/range-types` with name/color/description; system types protected. | Settings serialization retains existing string/boolean conventions, unsupported edits disabled for nonadmin, retention changes disclosed. |
| S-02 | `NetworkDefaultsSettings.vue`, `VlanSettings.vue` → General | Default gateway intent, help on future-network-only effect; VLAN list/search/create/edit/delete, ID/name/network link and shared warnings. `/settings/default_gateway_position {value}`, `/vlans`, `/vlans/search`. | Existing network policies do not change on defaults Save; shared VLAN association survives network edit. |
| S-03 | `DNS.vue` → Settings / DNS | Forwarder add/remove/test, recursion toggle, plain/encrypted upstream configuration and custom provider hostname/addresses/DoH URL, DNSSEC toggle, SOA defaults with units/help. GET/PUT `/dns/forwarders`, `/dns/encryption`, `/dns/dnssec`, `/dns/soa-defaults`; POST `/dns/forwarders/test {ip}`. | Failed test vs save independent; no-recursion/encryption incompatibilities and filtering effects disclosed; inherited SOA values not silently reset. |
| S-04 | `DHCP.vue` → Settings / DHCP / Defaults & Options | Global option defaults, enabled-default selection, grouped catalog/RFC help, custom code/label/type/description add/delete, DHCP apply. `/dhcp/options`, PUT `/dhcp/options/defaults {options,enabledDefaults}`, POST `/dhcp/options/custom`, DELETE `/dhcp/options/custom/:code`, `/dhcp/apply`. Link to All Networks DHCP scope inventory instead of duplicating a second operational surface. | Option 51 excluded; referenced/system custom-option deletion errors preserved; scoped explicit values remain explicit. |
| S-05 | `InterfacePanel.vue` → General / Interfaces | Interface addresses/status, web bindings, redirect, global DNS/DHCP enable and per-interface service toggles. GET `/interfaces`, `/interfaces/config`, PUT `/interfaces/config` using current serializer. Preserve service-restart and access-loss notices. | Multiple interfaces, disabled/down interface, DHCP guardrails and reconnect behavior. Never activate service just by opening page. |
| S-06 | `RogueDhcp.vue` → DHCP / Rogue Detection | Enabled/interval, status, event list, individual/all acknowledge, event delete, active probe, authorized server IP/MAC/description add/delete. Routes are mounted under `/dhcp/rogue`: `/status`, `/events`, `/events/:id/acknowledge`, `/acknowledge-all`, `/probe`, `/authorized`, `/settings`. | Acknowledgement distinct from authorization/removal, probe in-flight/error, no background active probe on view entry. |
| S-07 | `Blocklists.vue`, `BlocklistSearch.vue`, `BlocklistAllowedDomains.vue`, `DomainWhitelist.vue` → Filtering | Category enable, feed URL edit, category/all refresh, schedule/feed-size limit, status/hit counts, domain search with matched category, exact/wildcard domain allowlist and reason. `/blocklists/categories`, category PUT/URL/refresh, `/refresh`, `/settings`, `/stats`, `/search`, `/whitelist`. | Recursion disabled state, failed feeds, URL rejection, wildcard validation, successful allowlist changes reflected in drill-ins. |
| S-08 | `GeoIP.vue`, `GeoIpAllowedIps.vue` → Filtering | Enable, allow/block mode, update schedule, country search/multiselect and rule CRUD, database refresh/status, stats/reset, IP/CIDR allowlist add/delete. `/geoip/status`, `/rules`, `/allowlist`, `/settings`, `/db/refresh`, `/stats`, `/stats/reset`. | Missing DB vs no hits, rule mode semantics, country multi-edit partial errors, no-recursion dependency. |
| S-09 | `AnomalyDetection.vue` → Filtering / Anomalies | Enable, sensitivity, scoring/training intervals, min training hours, retention, detector status, exempt clients/reason. `/anomalies/settings`, `/summary`, `/whitelist`. Distinguish learning, stale sidecar and disabled. | Nonadmin can inspect permitted facts but not settings writes; preserve learned model until explicit supported deletion/reset. |
| S-10 | `LogsSettings.vue`, `LogViewer.vue` → Maintenance / Logs & Audit | Audit action/entity/user filtering and pagination, detail expansion. Live DNS logs, search/filter/pause/clear controls already present, stream reconnect and teardown. `/audit`, `/audit/actions`, `/audit/entities`; `/logs/stream-token`, `/logs/stream`, `/logs/clear`. | Audit admin-only, stream DNS-read, clear admin-only. Short-lived single-use stream ticket, no bearer token persistence in a bookmark or tracking output. |
| S-11 | `BackupSettings.vue` → Maintenance / Backup & Restore | Schedule/retention fields, create/list/download/delete backup, upload/restore status and compatibility errors, reset database with existing typed confirmation. `/operations/backup`, `/backups`, `/backups/:id/download`, DELETE `/backups/:id`, `/restore`, `/reset-database`, settings bulk. Preserve binary upload/download contracts from operations store. | Failed upload remains actionable, incompatible backup distinct, reset confirmation required, no reset invoked by generic Save. |
| S-12 | `UpdatePanel.vue` → Maintenance / Updates | Current/available release, check, automatic-check preference, upgrade chain/minimum version disclosure, install confirmation, progress/reconnect, dismiss/reset update state, lifecycle migration report download. `/version`, `/check`, `/install`, `/update-status`, `/update-dismiss`, `/ip-lifecycle-migration-report`; update preference via supported `/settings/:key {value}`. | Multi-hop chain, failed migration/report, restart reconnect and blocked install preserved. No automatic install from Check. |
| S-13 | `CertificateSettings.vue` → Access / TLS Certificate | Current certificate expiry/SAN/issuer, CSR common name/SAN/org/unit/locality/state/country/key profile, CSR copy/download, certificate-only or key+cert upload, reset self-signed confirmation. `/operations/certs/info`, `/csr`, `/upload`, `/reset`. | Private key/password never logged, certificate-only uses server-held CSR key, invalid pair preserves editor and does not claim success. |
| S-14 | `Users.vue` → Access / Users | Human/service account type, username/role, create credential reveal, role edit, password reset, delete, token list/create/name/expiry/revoke and one-time reveal. `/users/roles`, `/users`, `/:id`, `/:id/reset-password`, `/:id/tokens`, `/:id/tokens/:tokenId`. | Last-admin/self-delete protections, service account cannot use password flow, one-time secrets cleared on dismiss and not restored from storage. |
| S-15 | `PiholeImportPanel.vue`, `usePiholeImport.js`, NetworkDialogs wizard import step → Maintenance / Import | Remote URL/password probe/fetch or local file parse, dataset preview/counts and selection, import mapping/result/errors. `/pihole/probe`, `/fetch`, `/parse`, `/import`. Reuse existing composable and request/file shapes. Keep import target context explicit and retain first-network onboarding access. | Cancel before import does not write, credentials not retained, partial/failure outcomes and protocol/IP refresh correct. |
| S-16 | `SubnetCalculator.vue` → Tools / Subnet Calculator | CIDR/prefix calculation, outputs and supported copy/selection/allocation handoff. POST `/subnets/calculate {cidr,new_prefix}`. | Calculation never creates a network; large-output limit shown; handoff prefills N-03/N-04 without auto-save. |
| S-17 | `AppearanceSettings.vue`, HeaderBar user menu → Preferences | Existing themes, time format and other exposed appearance/preferences, small-text size. `/auth/preferences` with supported preference keys; theme store and per-user workspace storage for UI-only additions. | Theme/time changes update tables, popouts and charts; current-interface settings remain independent where intended. |
| S-18 | `SetupWizard.vue`, NetworkDialogs first-network wizard → Initial setup | Preserve setup status/read gate, existing setup form and server validation, interface setup, network setup, optional import, skip/resume paths. `/setup/status`, POST `/setup`, then relevant S-05/N-04/S-15 APIs. | Fresh appliance can become usable through new UI; completed setup not replayed on refresh; partially completed steps not duplicated. |
| G-01 | `HeaderBar.vue`, `FooterBar.vue`, `AppLayout.vue` → shared application shell | Analytics/IP Management/Settings navigation, scanner status/next run/popover, dnsmasq status, CPU/RAM/disk detail, anomaly badge, update banner, user menu, version/session/freshness. `/health/system`, `/scans`, `/scans/next`, `/version`, metrics/anomaly stores. | Preserve click destinations, session expiry and sticky header behavior; status failure is not rendered as zero/healthy. |
| G-02 | Login, ChangePassword, NotFound, auth/router/landing utilities → account shell | Login, required password change including CLI reset actor, password policy feedback, logout, return-to-requested/last-view behavior, missing-page recovery. `/auth/login`, `/me`, `/change-password`, `/preferences`, `/logout`. | Forced change precedes protected navigation; expired session restores legitimate workspace URL after login; sanitized internal redirects only. |
| O-01 | New workspace apply banner + Maintenance diagnostics | Desired vs applied DNS/DHCP generations, attempts/errors, lifecycle/topology diagnostics, admin repair with impact confirmation. `/metrics/configuration-generation`, `/metrics/ip-lifecycle`, `/metrics/network-dhcp`, POST `/operations/network-dhcp/repair-derived`. | Successful DB commit with failed config stays visible; repair uses existing owner, is explicit, and refreshes all affected contexts. |

### Analytics packages

| ID | Target and retained functionality | API/source mapping | Acceptance |
| --- | --- | --- | --- |
| Q-01 | Dashboard: retain all existing cards, common time range, query/action distribution, top clients/domains and service summaries. Restyle cards/header using workspace tokens. | `Dashboard.vue`, `stores/dashboard.js`; metrics timeseries/services, health/system, analytics top-clients/top-domains and action-breakdown/query-volume where used. | Counts/charts/table drill-ins share selected time window and distinguish missing data from zero. |
| Q-02 | Performance: DNS/DHCP volume, latency avg/p95/max, query rate/timeouts, resource CPU/RSS/heap, cache and proxy measurements, DNSSEC unsupported-domain table. | `Performance.vue`, `/metrics/timeseries`, `/metrics/proxy-perf`, `/analytics/dnssec/top-unsupported-domains`, existing chart helpers. | Every existing series, units, tooltip and refresh control survives; theme/font preferences do not clip axes. |
| Q-03 | Intelligence: blocklist/GeoIP top clients/domains/categories, client-domain drill-ins, time range and allowlist actions. | `Intelligence.vue`, `/metrics/blocklist-hits`, `/metrics/geoip-hits`, analytics blocklist/geoip routes, `/client/:ip/domains`, `/domain/:name/clients`, S-07/S-08 mutations. | Drill-in retains range/context and adding exemption refreshes corresponding tables. |
| Q-04 | Anomaly triage: queue/filter, history/pattern, score/features/heatmap/trend, raw DNS evidence, device history, model detail, acknowledgements, dismiss/delete/whitelist. | `Anomalies.vue`, `AnomaliesWorkspace.vue`, anomaly components/store; `/anomalies/active`, `/summary`, `/events`, `/client/:identity`, `/model`, `/evidence`, `/acknowledge`, `/:id/dismiss`, DELETE `/:id`, `/whitelist`, device history. | MAC identity distinct from reused IP. Preserve timestamp/window/evidence filters. Use live mode by default in production. Threat shape/peer medians that have no backend computation are unavailable, never sample values posing as findings. |

Analytics retains a top-level destination. Contextual Open analytics from an IP/network may prefill supported filters, but must not claim an entire dashboard is network-filtered unless every query actually supports that constraint.

Developer-only tracking, API browser and Theme Lab remain development tooling. Internal analytics query and localhost deep health remain internal operational endpoints. They are deliberately not exposed as general operator actions. Preserve DebugPanel under existing visibility rules, and keep secrets/request bodies out of tracking.

## 11. Shared workspace work packages

| ID | Implementation instructions | Acceptance |
| --- | --- | --- |
| W-01 | Extract preview into section 5 boundaries without visual changes. Add workspace context codec and preserve current route wrapper. | Existing preview tests pass; All Networks/folder/network/drill-in URL round trips and old `/networks` still render. |
| W-02 | ResourceExplorer: folder IDs as keys, empty folders, allocated leaf inventory, unallocated hierarchy, search result highlighting, accessible collapse/open controls. | Duplicate/renamed folders, nested parents, exact-IP and hostname matching outside current address page, Back/Forward. |
| W-03 | Replace notice-only column chooser with catalog-backed picker. Add explicit state/type/online/scan/range/protocol filters, clear-filter chips, page-size control, server sort/paging. Keep core identity column visible. | Persist per view/context kind, restore valid columns after upgrades, all canonical legacy columns available, filtered count vs subnet size clear. |
| W-04 | One AddressGrid with density prop. Preserve spacious 16-column and compact 64-column reference density where viewport permits. Selection, drag/shift runs, keyboard arrows/Enter/Space/context menu share canonical rows/actions. | No synthetic address classification; small prefixes/large page ranges correct; no all-prefix IPv6 expansion; grid legend announces semantics without color dependence. |
| W-05 | Implement registry/context-target action model and modal/detail host. Remove text-dispatched notices as each action becomes live. | Every visible non-disabled action invokes a real navigation, clipboard, form or API workflow. Focus returns to invoker, Escape dismisses topmost overlay, unsaved form is not silently discarded. |
| W-06 | Implement keyed resource reads and invalidation in section 7, independent errors, loading skeletons, background refresh using `useAutoRefresh.js` patterns. | No per-zone initial fan-out, no denied-domain requests, late response discard, no stale drawer after off-page mutation, no overlapping polling after unmount. |
| W-07 | Finish responsive/font/theme/a11y pass using rendered application. Avoid nested main landmarks. Use real menu/tab/dialog semantics and text alternatives. | 1440/1280/1024/768 CSS-pixel widths, 200% zoom, all font sizes/themes, long names and open details: action group reachable, gauges wrap, no clipped Save or silent horizontal page overflow. |

Default table columns:

- Networks: name, CIDR, folder, VLAN, domain, gateway, utilization, state, actions.
- Addresses: IP, canonical hostname, Status, Type, Online, MAC, last seen, actions.
- DNS records: owner/FQDN, RR type, value, TTL, enabled, source, related network, actions. Canonical IP fields remain selectable when the row has an address.
- DHCP scope inventory: network, pool intervals, lease time, enabled, description, actions. Add counts only with accurately scoped read data.
- DHCP addresses: IP, canonical hostname, MAC, assignment, lease status, expiry, IP Status/Type, Online, actions.
- Ranges: type, bounds, size, description, owner, actions.

Expose every appropriate key from `ipTableColumns.js`, including device/OS/confidence/fingerprint, scanning, range tags and provenance. Do not reduce data parity to the short default column set. Detail panels expose full values even when a column is hidden.

## 12. Test specification

### 12.1 Test files and ownership

- Extend `client/tests/unit/views/NetworksWorkspace.test.js` and `networks-workspace-data.test.js` for route shell/context/render compatibility.
- Extend `AddressDetailsPanel.test.js` for existing live actions plus stale selection/permission/lifecycle behavior.
- Add focused files under `client/tests/unit/views/networks-workspace/` named `context`, `resources`, `actions`, `network-editor`, `network-transform`, `dns-editors`, `dhcp-editors`, `ranges`, `grid-selection` and `permissions`, each with `.test.js` suffix. Test user-visible outcomes and exact API contracts, not CSS implementation snapshots.
- Extend existing `NetworkDialogsTarget.test.js`, `subnetTransformations.test.js`, `shared-address.test.js`, lifecycle/column tests when shared logic changes. Both interfaces are consumers until cutover.
- Add server integration/read-model tests for B-01 through B-05 using existing database/auth test harnesses. Extend governance differential tests for changes touching canonical reads or write-path plumbing. Do not rewrite backend transition policy to simplify a UI fixture.
- Existing settings and anomaly tests remain regression gates during their packages, especially `dns-soa-defaults`, `UpdatePanelLifecycleReport`, `anomaliesWorkspaceLive`, device and scanner tests.

### 12.2 Required scenarios

| Test ID | Setup → action → expected result |
| --- | --- |
| T-01 | All Networks → DNS/DHCP → all permitted zones/scopes, including resources not linked to the selected network. |
| T-02 | Select folder with shared zone → one zone row, correct association labels, explicit whole-zone access. |
| T-03 | Select network A → DNS/DHCP tabs → only contextual rows until explicit whole-zone/scope drill-in. |
| T-04 | Find hostname on page 3 of `/22` with both explorer/table filters → correct globally filtered result and total. |
| T-05 | Exact unused IP beyond first page → canonical available row, correct network, no persistence/event. |
| T-06 | Slow response A, switch to B → A cannot overwrite B's rows, summary or detail panel. |
| T-07 | Open address → related DNS then DHCP → original panel remains open with correct IP/owning network. |
| T-08 | Save succeeds, refresh fails → Saved; refresh failed; retry reads only. |
| T-09 | Folder-row edit with null legacy selected node → correct ID updated; no `.data` crash. |
| T-10 | Create root succeeds/configure fails → Resume configuration uses returned ID, no duplicate root. |
| T-11 | Two `/25` children fully consume `/24` → parent absent from allocatable free-space results. |
| T-12 | Synthetic `/24` with scope `.33–.128` → preview split → each `/25` gets the exact standard pool shown; execute preserves disclosed result. Use synthetic test data, never active public probing. |
| T-13 | Merge those children → target default scope shown before execution; former network/broadcast/gateway rows have canonical new roles and no invented online/rogue facts. |
| T-14 | Split/merge with no source scope → no created scope. Conflicting source lease/options/gateway/domain policy → clear conflict, no arbitrary choice. |
| T-15 | Plan changes after review → 409 stale plan → renewed review required; no hidden second preview/token execution. |
| T-16 | Same transformation through new UI, legacy API flow and opposite merge order → equivalent canonical allocation/DNS/PTR/DHCP/range projection. |
| T-17 | Reserve/release unused scope member → allocation and scope availability stay separate across Addresses/DNS/DHCP/grid/details. |
| T-18 | Reserve selection with gaps/topology addresses/late run failure → exact runs only, skip counts, no replay of successes. |
| T-19 | Try release on static DNS/static DHCP/system/gateway → action absent/disabled and server rejection retained. |
| T-20 | Add/rename/disable/delete DNS A/AAAA/manual PTR and DHCP Reservation in different orders → canonical hostname/PTR convergence and exclusions match existing governance tests. |
| T-21 | Create every supported RR type with null/zero TTL/priority/weight/port as applicable → values preserved, wrong type fields not sent accidentally. |
| T-22 | Generated PTR/manual override/shared zone deletion → owner/impact shown and correct server behavior. |
| T-23 | Create range succeeds/scope fails → retry uses range ID; canceled/error state reports intermediate resource. |
| T-24 | Multi-pool read response → all intervals shown, pool gaps not counted, lossy first-pool save disabled. |
| T-25 | Scope start/end trim and whole removal → DHCP endpoint used, no attached orphan range deletion. Middle cut gives unsupported explanation. |
| T-26 | DHCP lease conversion/reservation outside pool/duplicate MAC or IP → correct owning protocol ID, safe conflict feedback, updated canonical facts. |
| T-27 | DHCP option inheritance, explicit empty reset, option 51 → effective values accurate and single lease-duration control. |
| T-28 | IP range tag overlaps → confirmation and exact selected runs; no allocation/liveness effect. |
| T-29 | Metadata Expired/scope membership history → history does not replace current availability display. |
| T-30 | Global public network loaded with inherited scanning → no traffic initiated, manual Scan now remains explicit and policy controls honest. |
| T-31 | Probe failure, duplicate scan 409, active scan completion → truthful result and refreshed stats, stopped polling. |
| T-32 | Readonly/DNS-only/DHCP-only/admin roles → allowed data works, no other domain fetch, write denied appropriately, no whole-workspace failure. |
| T-33 | Expired session/forced password change/role revoked → auth routing and permission refresh work, no secret in URL. |
| T-34 | Delete currently selected folder/network/zone/scope → nearest surviving context and clear disappearance message. |
| T-35 | Summary with overlaid pool + allocated members → no double counting; counts not current-page counts. |
| T-36 | DNS/DHCP DB change committed, generated apply pending/failed → persistent status, valid explicit retry/apply path, no misleading rollback. |
| T-37 | Small text 0/+1/+2, each supported theme, 200% zoom, open panel, narrow viewport → only eligible fonts scale, gauges wrap, controls stay reachable. |
| T-38 | Keyboard-only table/grid/menu/form/related navigation → focus/selection/Escape/Enter operate without mouse and are announced. |
| T-39 | Fresh setup and optional import → steps can resume without duplicate network/VLAN/protocol writes. |
| T-40 | Existing Analytics, settings, backup/certificate/users/update/import flows → source-specific acceptance in section 10, including sensitive-data handling and service reconnect. |
| T-41 | Anomaly production live view with empty/unavailable evidence → no sample threats/peer medians presented as measured facts. |
| T-42 | Existing bookmarks, preview/current switch, per-user saved state, Back/Forward → preserved valid context with safe fallback for deleted resources. |

### 12.3 Execution gates

For each package run the focused tests using the documented scripts, for example:

```bash
npm run test:client -- tests/unit/views/NetworksWorkspace.test.js
```

Run the full relevant suite when a package changes shared UI/model behavior. Canonical IP/display changes require the focused tests, full relevant suite, lint and ownership check specified in `AGENTS.md`. At IP-management parity and application-wide parity gates run:

```bash
npm test
npm run lint
npm run format:check
npm run check:db-ownership
npm run build:client
```

Use `npm run format` only with awareness of unrelated worktree changes. Formatting applies to code, this Markdown plan is intentionally ignored by Prettier.

Use browser automation against a development instance for the rendered scenarios. Mutation fixtures belong in an isolated test database. Never run destructive operations, DHCP service activation or public-address scans against the live reference merely to satisfy a UI smoke test. The existing appliance install/upgrade harness has its own destructive-target rules and is only relevant at release validation.

## 13. Ordered implementation sequence

Each row is independently reviewable after its listed acceptance tests pass. Do not mark a phase complete while a visible control still points to a notice placeholder. Later phases may reuse completed contracts, but do not broaden a phase into unrelated cleanup.

| Phase | Work IDs and files | Depends on | Exit evidence |
| --- | --- | --- | --- |
| P0: Freeze and characterize | W-01 baseline extraction; characterize current panel/preview behavior; capture baseline screenshots in gitignored `screenshots/` | None | Current interface and preview still work, source inventory reconciled with Appendix A, no policy change |
| P1: Read/context foundation | B-01/B-02/B-03, W-02/W-03/W-06, route codec and shared column adapters | P0 | T-01–T-08, T-32–T-35, T-42, no initial record fan-out or page-only search claims |
| P2: Complete native address operations | W-04/W-05, A-01/A-02/A-04–A-08, R-01/R-02, permission-aware action registry. Protocol editor handoff A-03 lands with P4/P5. | P1 | T-17–T-19, T-28–T-31, T-38 across all presentations; protocol CRUD remains an explicitly pending package |
| P3: Network lifecycle | B-04, N-01–N-10, NetworkEditor/Transform/Delete dialogs | P1, action registry from P2 | T-09–T-16, T-30/T-31/T-34, exact plan execution and default scopes |
| P4: DNS workflows | D-01–D-06, DNS half of A-03, zone drill-in, DNS panels/editors | P1/P2 | DNS cases of T-20–T-22, shared/unlinked/non-address records, all record fields/actions |
| P5: DHCP workflows | H-01–H-07, DHCP half of A-03, R-03, DHCP panels/editors | P1/P2/B-04 | T-20 cross-protocol cases and T-23–T-27, reservations outside scopes and multi-pool read correctness |
| P6: IP-management parity gate | B-05, O-01, W-07, all remaining preview notices replaced | P2–P5 | Full suite/build/ownership/format/lint, T-01–T-38/T-42, rendered parity evidence, old UI available |
| P7: Settings/configuration | S-01–S-10, S-16/S-17, settings workspace shell and leaf editors | P6 | All Configuration/Preferences/Tools tab functions and deep links retained |
| P8: Appliance/account workflows | S-11–S-15/S-18, G-01/G-02 | P6, settings shell | Fresh setup plus maintenance/auth flows verified on safe fixtures; private fields not persisted or tracked |
| P9: Analytics and anomaly | Q-01–Q-04, analytics workspace files | P6 | Existing series/drill-ins/actions preserved, production live-only semantics, T-41 |
| P10: Default-route cutover | Router/navigation/landing compatibility and final copy | P7–P9 or separately approved IP-only default | Both parity gates passed, no unowned route/workflow, maintainer reviews rendered result |

Cutover changes navigation defaults only after a deliberate maintainer decision. During development `/networks` remains current and `/networks-preview` remains workspace. At cutover move the legacy route to an explicit `/networks-classic`, point `/networks` at the workspace, and keep `/networks-preview` as a compatibility alias preserving query parameters. Preserve Settings area/section links and Analytics bookmarks. Removing legacy files is a separate follow-up after practical validation, not part of the first default switch.

No commits, tags, pushes, release builds/signing or deployments are implied by this planning document. Version branding can say 0.5.0 preview without changing the root release version until the maintainer's release workflow calls for it.

## 14. Definition of done and unresolved limits

IP-management parity is done when every W/N/A/R/D/H/B/O work item has its functional UI, supported API binding, permission behavior, error handling, invalidation and tests, and all user-visible current IP workflows have a mapped replacement. A working address table plus a Create menu is not parity.

Application-wide parity additionally requires every S/G/Q work item and route/bookmark compatibility. Visual consistency does not require identical three-column layout on a certificate form or performance chart.

The following limits are explicit implementation constraints, not invented functionality:

- Keep **All Networks** until a new label is selected.
- Multi-pool writes and full IPv6 network/DHCP/probe operations are not fully supported by current write routes. Preserve reads, prevent destructive flattening, and leave unsupported actions clearly unavailable. If these become required, first specify and test the backend extension.
- Network create/configure and manual range/scope create are currently multi-call workflows, not transactions. Make partial completion resumable and visible. Do not silently claim atomicity or auto-delete state another operator may now use.
- Anomaly threat-shape/peer statistics without backend computations cannot become production measurements by restyling sample data.
- Server-side complete search, independent address details/summary, permission projection and audit scoping are planned additions, not available APIs at the baseline commit.

### Repository hygiene observed during planning

A repository scan for key/credential markers found certificate input/help content in `client/src/views/settings/CertificateSettings.vue` and synthetic credentials in `server/tests/integration/security.test.js`. The tracked certificate/key filename scan found no PEM/key/certificate artifacts. These are not confirmed leaked secrets. Retain the legitimate certificate UI and test fixtures; keep them clearly synthetic, and exclude real exports, credentials, screenshots and development inventories from release artifacts. No unrelated files were changed or removed.

## Appendix A. Existing endpoint coverage index

The index below is generated from declared route registrations at the baseline. It includes supporting/internal endpoints so absence from an operator menu is deliberate. Route-family work IDs identify the responsible package; the detailed behavior lives in sections 6–10. Proposed B-series additions are not included as existing endpoints.

The baseline declares **210 method/path pairs** across 29 modules (including authentication). The `/api-browser` mount is intentionally outside `/api`; rogue DHCP is `/api/dhcp/rogue`, not the route filename. Public/bootstrap/internal middleware exceptions remain unchanged.

### analytics

Source: [server/src/routes/analytics.js](../server/src/routes/analytics.js). Work: Q-01–Q-03.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/analytics/top-clients` |
| GET | `/api/analytics/top-domains` |
| GET | `/api/analytics/dnssec/top-unsupported-domains` |
| GET | `/api/analytics/top-blocked` |
| GET | `/api/analytics/query-volume` |
| GET | `/api/analytics/action-breakdown` |
| GET | `/api/analytics/client/:ip/domains` |
| GET | `/api/analytics/domain/:name/clients` |
| GET | `/api/analytics/blocklist/top-clients` |
| GET | `/api/analytics/blocklist/top-domains` |
| GET | `/api/analytics/blocklist/top-categories` |
| GET | `/api/analytics/blocklist/top-client-domains` |
| GET | `/api/analytics/geoip/top-clients` |
| GET | `/api/analytics/geoip/top-domains` |

### anomalies

Source: [server/src/routes/anomalies.js](../server/src/routes/anomalies.js). Work: Q-04, S-09.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/anomalies/active` |
| GET | `/api/anomalies/summary` |
| POST | `/api/anomalies/acknowledge` |
| GET | `/api/anomalies/events` |
| GET | `/api/anomalies/client/:identity` |
| GET | `/api/anomalies/client/:identity/model` |
| GET | `/api/anomalies/client/:identity/evidence` |
| DELETE | `/api/anomalies/:id` |
| POST | `/api/anomalies/:id/dismiss` |
| GET | `/api/anomalies/whitelist` |
| POST | `/api/anomalies/whitelist` |
| DELETE | `/api/anomalies/whitelist/:id` |
| GET | `/api/anomalies/settings` |
| PUT | `/api/anomalies/settings` |

### api-browser

Source: [server/src/routes/api-browser.js](../server/src/routes/api-browser.js). Work: Developer tooling only.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api-browser/routes` |
| GET | `/api-browser` |

### audit

Source: [server/src/routes/audit.js](../server/src/routes/audit.js). Work: B-05, A-06, S-10.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/audit` |
| GET | `/api/audit/actions` |
| GET | `/api/audit/entities` |

### blocklists

Source: [server/src/routes/blocklists.js](../server/src/routes/blocklists.js). Work: S-07, Q-03.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/blocklists/categories` |
| PUT | `/api/blocklists/categories/:slug` |
| PUT | `/api/blocklists/categories/:slug/url` |
| POST | `/api/blocklists/categories/:slug/refresh` |
| POST | `/api/blocklists/refresh` |
| GET | `/api/blocklists/stats` |
| GET | `/api/blocklists/settings` |
| PUT | `/api/blocklists/settings` |
| GET | `/api/blocklists/whitelist` |
| POST | `/api/blocklists/whitelist` |
| DELETE | `/api/blocklists/whitelist/:id` |
| GET | `/api/blocklists/search` |

### devices

Source: [server/src/routes/devices.js](../server/src/routes/devices.js). Work: A-07, Q-04.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/devices/:mac/fingerprint` |
| GET | `/api/devices/:mac/fingerprint/history` |
| PUT | `/api/devices/:mac/fingerprint` |
| DELETE | `/api/devices/:mac/fingerprint` |

### dhcp

Source: [server/src/routes/dhcp.js](../server/src/routes/dhcp.js). Work: H-01–H-07, S-04.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/dhcp/scopes` |
| POST | `/api/dhcp/scopes` |
| PUT | `/api/dhcp/scopes/:id` |
| DELETE | `/api/dhcp/scopes/:id` |
| GET | `/api/dhcp/reservations` |
| POST | `/api/dhcp/reservations` |
| PUT | `/api/dhcp/reservations/:id` |
| DELETE | `/api/dhcp/reservations/:id` |
| GET | `/api/dhcp/scopes/:id/addresses` |
| GET | `/api/dhcp/leases` |
| POST | `/api/dhcp/sync-leases` |
| POST | `/api/dhcp/apply` |
| GET | `/api/dhcp/available-ranges` |
| GET | `/api/dhcp/options` |
| POST | `/api/dhcp/options/custom` |
| DELETE | `/api/dhcp/options/custom/:code` |
| PUT | `/api/dhcp/options/defaults` |

### dns

Source: [server/src/routes/dns.js](../server/src/routes/dns.js). Work: D-01–D-06, S-03.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/dns/zones` |
| GET | `/api/dns/zones/:id` |
| POST | `/api/dns/zones` |
| PUT | `/api/dns/zones/:id` |
| DELETE | `/api/dns/zones/:id` |
| GET | `/api/dns/zones/:zoneId/records` |
| POST | `/api/dns/zones/:zoneId/records` |
| PUT | `/api/dns/zones/:zoneId/records/:id` |
| DELETE | `/api/dns/zones/:zoneId/records/:id` |
| POST | `/api/dns/apply` |
| GET | `/api/dns/forwarders` |
| PUT | `/api/dns/forwarders` |
| GET | `/api/dns/dnssec` |
| PUT | `/api/dns/dnssec` |
| GET | `/api/dns/encryption` |
| PUT | `/api/dns/encryption` |
| GET | `/api/dns/soa-defaults` |
| PUT | `/api/dns/soa-defaults` |
| POST | `/api/dns/forwarders/test` |
| GET | `/api/dns/resolve` |

### folders

Source: [server/src/routes/folders.js](../server/src/routes/folders.js). Work: N-01/N-08.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/folders` |
| POST | `/api/folders` |
| PUT | `/api/folders/:id` |
| DELETE | `/api/folders/:id` |

### geoip

Source: [server/src/routes/geoip.js](../server/src/routes/geoip.js). Work: S-08, Q-03.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/geoip/status` |
| GET | `/api/geoip/rules` |
| POST | `/api/geoip/rules` |
| PUT | `/api/geoip/rules/:id` |
| DELETE | `/api/geoip/rules/:id` |
| GET | `/api/geoip/allowlist` |
| POST | `/api/geoip/allowlist` |
| DELETE | `/api/geoip/allowlist/:id` |
| PUT | `/api/geoip/settings` |
| POST | `/api/geoip/db/refresh` |
| GET | `/api/geoip/stats` |
| POST | `/api/geoip/stats/reset` |

### health

Source: [server/src/routes/health.js](../server/src/routes/health.js). Work: G-01, S-12; /deep is localhost-only.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/health` |
| GET | `/api/health/deep` |
| GET | `/api/health/system` |

### interfaces

Source: [server/src/routes/interfaces.js](../server/src/routes/interfaces.js). Work: S-05/S-18.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/interfaces` |
| GET | `/api/interfaces/config` |
| PUT | `/api/interfaces/config` |

### internal-analytics

Source: [server/src/routes/internal-analytics.js](../server/src/routes/internal-analytics.js). Work: Internal sidecar query only.

| Method | Existing mounted path |
| --- | --- |
| POST | `/api/internal/analytics/query` |

### logs

Source: [server/src/routes/logs.js](../server/src/routes/logs.js). Work: S-10.

| Method | Existing mounted path |
| --- | --- |
| POST | `/api/logs/stream-token` |
| GET | `/api/logs/stream` |
| POST | `/api/logs/clear` |

### metrics

Source: [server/src/routes/metrics.js](../server/src/routes/metrics.js). Work: O-01, G-01, Q-01–Q-03.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/metrics/timeseries` |
| GET | `/api/metrics/blocklist-hits` |
| GET | `/api/metrics/geoip-hits` |
| GET | `/api/metrics/proxy-perf` |
| GET | `/api/metrics/ip-lifecycle` |
| GET | `/api/metrics/network-dhcp` |
| GET | `/api/metrics/configuration-generation` |
| GET | `/api/metrics/services` |

### operations

Source: [server/src/routes/operations.js](../server/src/routes/operations.js). Work: S-11/S-13, O-01.

| Method | Existing mounted path |
| --- | --- |
| POST | `/api/operations/network-dhcp/repair-derived` |
| POST | `/api/operations/backup` |
| GET | `/api/operations/backups` |
| GET | `/api/operations/backups/:id/download` |
| DELETE | `/api/operations/backups/:id` |
| POST | `/api/operations/restore` |
| GET | `/api/operations/certs/info` |
| POST | `/api/operations/certs/upload` |
| POST | `/api/operations/certs/csr` |
| POST | `/api/operations/certs/reset` |
| POST | `/api/operations/reset-database` |

### pihole

Source: [server/src/routes/pihole.js](../server/src/routes/pihole.js). Work: S-15/S-18.

| Method | Existing mounted path |
| --- | --- |
| POST | `/api/pihole/probe` |
| POST | `/api/pihole/fetch` |
| POST | `/api/pihole/parse` |
| POST | `/api/pihole/import` |

### range-types

Source: [server/src/routes/range-types.js](../server/src/routes/range-types.js). Work: R-01/R-02, S-01.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/range-types` |
| POST | `/api/range-types` |
| PUT | `/api/range-types/:id` |
| DELETE | `/api/range-types/:id` |

### ranges

Source: [server/src/routes/ranges.js](../server/src/routes/ranges.js). Work: R-01–R-03, H-02.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/subnets/:subnetId/ranges` |
| POST | `/api/subnets/:subnetId/ranges` |
| PUT | `/api/subnets/:subnetId/ranges/set-type` |
| PUT | `/api/subnets/:subnetId/ranges/:id` |
| DELETE | `/api/subnets/:subnetId/ranges/:id` |

### rogue-dhcp

Source: [server/src/routes/rogue-dhcp.js](../server/src/routes/rogue-dhcp.js). Work: S-06.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/dhcp/rogue/status` |
| GET | `/api/dhcp/rogue/events` |
| POST | `/api/dhcp/rogue/events/:id/acknowledge` |
| POST | `/api/dhcp/rogue/acknowledge-all` |
| DELETE | `/api/dhcp/rogue/events/:id` |
| POST | `/api/dhcp/rogue/probe` |
| GET | `/api/dhcp/rogue/authorized` |
| POST | `/api/dhcp/rogue/authorized` |
| DELETE | `/api/dhcp/rogue/authorized/:id` |
| PUT | `/api/dhcp/rogue/settings` |

### scans

Source: [server/src/routes/scans.js](../server/src/routes/scans.js). Work: N-09, A-05, G-01.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/scans` |
| GET | `/api/scans/next` |
| GET | `/api/scans/:id` |
| POST | `/api/scans` |
| POST | `/api/scans/probe` |
| DELETE | `/api/scans/:id` |

### settings

Source: [server/src/routes/settings.js](../server/src/routes/settings.js). Work: S-01–S-05, S-07–S-12.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/settings` |
| PUT | `/api/settings/bulk` |
| PUT | `/api/settings/:key` |

### setup

Source: [server/src/routes/setup.js](../server/src/routes/setup.js). Work: S-18.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/setup/status` |
| POST | `/api/setup` |

### subnets

Source: [server/src/routes/subnets.js](../server/src/routes/subnets.js). Work: N-01–N-10, A-01–A-06, S-16.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/subnets` |
| GET | `/api/subnets/:id` |
| POST | `/api/subnets` |
| POST | `/api/subnets/merge/preview` |
| POST | `/api/subnets/merge` |
| POST | `/api/subnets/apply-template` |
| PUT | `/api/subnets/:id` |
| POST | `/api/subnets/:id/divide/preview` |
| POST | `/api/subnets/:id/divide` |
| POST | `/api/subnets/:id/configure` |
| DELETE | `/api/subnets/:id` |
| POST | `/api/subnets/calculate` |
| GET | `/api/subnets/:id/ips` |
| PUT | `/api/subnets/:id/ips/bulk-allocation` |
| PUT | `/api/subnets/:id/ips/:ip/allocation` |
| PUT | `/api/subnets/:id/ips/:ip/scan-enabled` |
| GET | `/api/subnets/:id/ips/:ip/events` |

### tracking

Source: [server/src/routes/tracking.js](../server/src/routes/tracking.js). Work: Developer instrumentation only.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/dev/tracking` |
| POST | `/api/dev/tracking` |
| DELETE | `/api/dev/tracking` |

### users

Source: [server/src/routes/users.js](../server/src/routes/users.js). Work: S-14.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/users/roles` |
| GET | `/api/users` |
| POST | `/api/users` |
| PUT | `/api/users/:id` |
| DELETE | `/api/users/:id` |
| POST | `/api/users/:id/reset-password` |
| GET | `/api/users/:id/tokens` |
| POST | `/api/users/:id/tokens` |
| DELETE | `/api/users/:id/tokens/:tokenId` |

### version

Source: [server/src/routes/version.js](../server/src/routes/version.js). Work: S-12, G-01.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/version` |
| POST | `/api/version/check` |
| GET | `/api/version/update-status` |
| GET | `/api/version/ip-lifecycle-migration-report` |
| POST | `/api/version/install` |
| POST | `/api/version/update-dismiss` |

### vlans

Source: [server/src/routes/vlans.js](../server/src/routes/vlans.js). Work: N-05/N-08, S-02.

| Method | Existing mounted path |
| --- | --- |
| GET | `/api/vlans` |
| GET | `/api/vlans/search` |
| POST | `/api/vlans` |
| PUT | `/api/vlans/:id` |
| DELETE | `/api/vlans/:id` |

### auth

Source: [server/src/auth/routes.js](../server/src/auth/routes.js). Work: B-01, G-02, S-17.

| Method | Existing mounted path |
| --- | --- |
| POST | `/api/auth/login` |
| POST | `/api/auth/change-password` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/me` |
| PUT | `/api/auth/preferences` |
