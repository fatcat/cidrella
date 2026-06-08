# Settings Panel — IA Consolidation Review

> Status: design review / not yet implemented. Captured 2026-06-08 from a
> ux-ui-expert review of the entire Settings panel. Goal: fewer pages, more
> compact, easier to navigate. Pick up here when ready to plan/implement.

## The problem

Settings is one **1766-line `System.vue` monolith** rendering a 180px left rail
with 4 PanelMenu-style groups → 17 flat tabs (numeric `activeTab`) → a giant
`v-if` body. The grouping reflects how the code grew (one tab per shipped
feature), not how an operator thinks:

- **17 flat tabs** exceed working-memory limits; group boundaries don't predict
  where a feature lives.
- **"System" is a catch-all** of 7 unrelated things (Backup, Certificates, Users,
  Themes, Logging, Updates, Import).
- **Related filtering split across 3 tabs** — Category Blocking / GeoIP / Anomaly
  are one logical job and share a whitelist concept that has no single home.
- **Rogue DHCP under "Security"** but it's a DHCP question (split from DHCP config).
- **Calculator** is a stateless tool, not a setting — category error.
- Rail items are `<a @click>` with no `href`/`role`/focus → **not keyboard- or
  screen-reader-accessible**.

## Consolidation map: 17 → 8 (rail shows 7)

| Before (17 tabs) | After top-level page | Sub-tab |
|---|---|---|
| Network (general) | **General** | Naming / Scanning / Address Types |
| VLANs | **General** | VLANs |
| Interfaces | **General** | Interfaces |
| Calculator | — **leaves Settings** → Tools / slide-over | — |
| DNS | **DNS** | (already converged: Forwarders / DNSSEC / SOA) |
| DHCP | **DHCP** | Scopes & Leases |
| Rogue DHCP | **DHCP** | Rogue Detection |
| Category Blocking | **Filtering** | Categories |
| GeoIP | **Filtering** | GeoIP |
| Anomaly Detection | **Filtering** | Anomalies |
| (shared whitelist) | **Filtering** | Whitelist (shared source of truth) |
| Users | **Access** | Users |
| Certificates | **Access** | TLS Certificate |
| Themes | **Preferences** | Appearance |
| Backup | **Maintenance** | Backup & Restore |
| Updates | **Maintenance** | Updates |
| Logging | **Maintenance** | Logs (DNSmasq / Audit) |
| Import Pi-hole | **Maintenance** | Import |

Resulting rail (7): **General · DNS · DHCP · Filtering · Access · Preferences ·
Maintenance** (+ Calculator removed to Tools). Biggest single win = **Filtering**
(three tabs → one; shared whitelist gets one home).

## Navigation options

### Option A — Consolidated rail + in-page sub-tabs  *(RECOMMENDED)*
The "tabbed" idea applied to the 7 consolidated groups instead of per-feature.
Rail → 7 task-named entries; each page has a horizontal sub-tab strip.
- **Pros**: smallest change for existing users; cheapest migration (most sub-views
  are already lazy-loaded components — re-parenting, not rewriting); narrow rail.
- **Cons**: a leaf is 2 clicks deep; needs a search box so e.g. "DNSSEC" stays
  findable; sub-tab labels must be disciplined.
- **Confidence: High (88%)**. A is a strict foundation for C (no wasted work).

### Option B — Scrollable page per category + anchored "on this page" mini-TOC
macOS System Settings / GitHub style. Each page is one scroll column; an anchor
list jumps to sections.
- **Pros**: everything discoverable by scrolling; calm, modern.
- **Cons**: heavy pages get very long; scroll-spy + sticky anchors is more work;
  fights table-dense pages (audit log, leases). Better for pure-form pages only.
- **Confidence: Medium (74%)**.

### Option C — Settings "home" card grid → focused drill-in pages
Landing grid (one card per area + one-line blurb) → focused page (internally uses
A's sub-tabs). Persistent search at top.
- **Pros**: most discoverable/teachable; "imaginative"; scales as areas are added.
- **Cons**: adds a nav level (can be 3 deep); power users resent the hop; heaviest
  lift.
- **Confidence: Medium (78%)**.

## Recommendation

**Adopt the Consolidation Map + Option A + a rail search box.** Highest
value-to-effort; directly kills the sprawl (17 → 7); reuses existing sub-view
components under thin `TabView` wrappers. Borrow Option C's *card descriptions* as
hover/empty-state copy so the taxonomy still teaches itself. Reserve Option B's
anchored-scroll only for pure-form pages (General, DNS) if desired — not the
table-heavy ones. **A later upgrades to C with zero rework of the pages.**

**Suggested first slice (vertical proof of concept): the Filtering merge** —
Category Blocking + GeoIP + Anomaly + shared Whitelist → one page with sub-tabs.
It's the biggest "stop hopping" win and forces the shared-whitelist
single-source-of-truth question.

### Top actions
1. Re-parent the 17 tabs into the 8-page map; remove Calculator from Settings.
2. Merge the 3 filtering features + shared whitelist into one **Filtering** page.
3. Add a rail **search** that deep-links to `page#sub-tab`; fix rail-item
   keyboard/ARIA (real links/buttons, focusable, `role`).

## Compactness tactics (apply per page)
- **Two-column forms** (promote the existing `.cert-fields-row` pattern).
- **Drop nested-card chrome**: `.content-card` has `margin: 3% 7%` + 1.25rem
  padding (~14% horizontal whitespace, "boxes in boxes") → flat section dividers
  (reuse `.setting-group` bottom border).
- **Collapsible "Advanced"** disclosure for DNSSEC/SOA, cert key-type/ECDSA,
  anomaly thresholds — keep the common path short.
- **Inline-edit small tables** (VLANs, Address Types) — optional polish.
- **One consistent Save model per page** (don't mix dirty-Save with auto-save).

## Discoverability with fewer entries
- Rail **search** indexing leaf labels + synonyms ("DNSSEC"→DNS, "rogue"→DHCP,
  "TLS/SSL"→Access › Certificate) — the linchpin that makes consolidation safe.
- **Consistent sub-tab labeling** (same horizontal `TabView` everywhere).
- **Deep links**: generalize the existing `?tab=` / `TAB_NAME_MAP` to
  `?page=dhcp&sec=rogue` so docs/support can link straight to a sub-tab.

## Migration risk / sequencing (cheapest path)
- `System.vue` is large but **shallow** — most tabs are already
  `defineAsyncComponent` imports (DNS, DHCP, Blocklists, GeoIP, Users, Interfaces,
  Anomaly, Update, Pihole, RogueDhcp). Re-parenting them = low-risk markup surgery.
- **Inline** tabs (Network general, VLANs, Calculator, Backup, Certificates,
  Themes, Audit) hold state/handlers inside `System.vue` → extract each into
  `views/settings/*.vue` first. This both enables the new IA **and breaks the
  monolith** — do it page-by-page so each is independently testable.
- **Ship A first.** A's pages later drop under C's cards with zero rework.
- **Preserve** `localStorage('cidrella_system_tab')` + `?tab=` deep links — map old
  numeric indices → new `page#sub-tab` so bookmarks/muscle memory don't break.

## Open questions for the architect
- Confirm a **single backend whitelist** store/endpoint so the merged Filtering
  page binds one source of truth (Categories + GeoIP share it).
- Certificate placement: **Access** (access config) vs a "Server" page — arguable.
- "Maintenance" grouping: some operators expect Updates/Backup near the top, not
  nested — pressure-test.
- Calculator-as-slide-over (invokable anywhere a CIDR is entered) is the
  highest-utility reframe vs. a global "Tools" surface.

## Density benchmark
The Certificate upload UX (drag-drop zones, live PEM validation with inline
ok/error states) is the in-repo example of dense-without-clutter — match it.

## Relevant files
- `client/src/views/System.vue` (the 1766-line monolith)
- Sub-views: `DNS.vue`, `DHCP.vue`, `Blocklists.vue`, `GeoIP.vue`, `Users.vue`,
  `AnomalyDetection.vue`, `RogueDhcp.vue`, `UpdatePanel.vue`, `SubnetCalculator.vue`
- Components: `InterfacePanel.vue`, `LogViewer.vue`, `PiholeImportPanel.vue`
