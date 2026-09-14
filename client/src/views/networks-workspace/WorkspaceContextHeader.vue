<template>
  <header class="context-header">
    <div class="context-breadcrumb">
      <button data-track="workspace-breadcrumb-estate" @click="emit('select-estate')">
        Infrastructure
      </button>
      <template v-if="contextKind === 'folder'">
        <i class="pi pi-chevron-right" />
        <span>{{ selectedFolder.name }}</span>
      </template>
      <template v-else-if="contextKind === 'network'">
        <i class="pi pi-chevron-right" />
        <button @click="emit('select-folder', selectedNetwork.folderId)">
          {{ selectedNetwork.folder }}
        </button>
        <i class="pi pi-chevron-right" />
        <span>{{ contextTitle }}</span>
      </template>
    </div>
    <div class="context-overview">
      <div class="context-title-row">
        <div class="context-identity">
          <span class="context-icon" :class="contextKind"><i :class="contextIcon" /></span>
          <div>
            <div class="title-line">
              <h2>{{ contextTitle }}</h2>
              <span v-if="contextKind === 'network'" class="state-chip"
                ><i /> {{ selectedNetwork.status }}</span
              >
            </div>
            <p>{{ contextSubtitle }}</p>
          </div>
        </div>
      </div>

      <div class="health-strip">
        <button
          v-for="stat in stats"
          :key="stat.label"
          class="health-stat"
          :class="{ interactive: stat.view }"
          :disabled="!stat.view"
          :data-track="stat.view ? `workspace-stat-${stat.view}` : null"
          @click="stat.view && emit('switch-view', stat.view)"
        >
          <span>{{ stat.label }}</span>
          <strong>{{ stat.value }}</strong>
          <small :class="stat.tone"><i v-if="stat.dot" />{{ stat.note }}</small>
        </button>
      </div>

      <div class="context-actions">
        <button
          v-if="canScan"
          class="button secondary"
          @click="emit('notify', 'Start network scan')"
        >
          <i class="pi pi-search" /> Scan now
        </button>
        <button v-if="hasActions" class="button secondary" @click="emit('open-menu', 'actions')">
          Actions <i class="pi pi-chevron-down" />
        </button>
        <button v-if="canCreate" class="button primary" @click="emit('open-menu', 'create')">
          <i class="pi pi-plus" /> Create
        </button>
      </div>
    </div>
  </header>

  <nav class="view-tabs" aria-label="Network workspace views">
    <button
      v-for="view in views"
      :key="view.key"
      :class="{ active: activeView === view.key }"
      :data-track="`workspace-tab-${view.key}`"
      @click="emit('switch-view', view.key)"
    >
      <i :class="view.icon" />
      {{ view.label }}
      <span>{{ view.count }}</span>
    </button>
  </nav>

  <section v-if="showSummary" class="view-summary">
    <div>
      <h3 v-if="viewMeta.title">{{ viewMeta.title }}</h3>
    </div>
    <div v-if="activeView === 'dns'" class="linked-resources">
      <button
        v-for="zone in summaryZones.slice(0, 2)"
        :key="zone.id"
        class="linked-card selected"
        @click="emit('filter-zone', zone)"
      >
        <i :class="zone.type === 'reverse' ? 'pi pi-replay' : 'pi pi-globe'" /><span
          ><small>{{ zone.type }}</small
          ><strong>{{ zone.name }}</strong></span
        ><em>{{ zone.record_count || 0 }}</em>
      </button>
      <span v-if="!summaryZones.length" class="linked-empty">No linked zones</span>
    </div>
    <div v-else-if="activeView === 'dhcp'" class="linked-resources">
      <button
        v-for="scope in summaryScopes.slice(0, 2)"
        :key="scope.id"
        class="linked-card selected"
        @click="emit('filter-scope', scope)"
      >
        <i class="pi pi-server" /><span
          ><small>{{ scope.enabled ? 'ACTIVE SCOPE' : 'DISABLED SCOPE' }}</small
          ><strong>{{ scope.start_ip }} – {{ scope.end_ip }}</strong></span
        ><em>{{ formatDuration(scope.effective?.lease_time || scope.lease_time) }}</em>
      </button>
      <span v-if="!summaryScopes.length" class="linked-empty">No DHCP scope</span>
    </div>
    <div v-else-if="activeView === 'ranges'" class="range-legend">
      <span><i class="legend-dot scope" />DHCP Scope</span>
      <span><i class="legend-dot infra" />Infrastructure</span>
      <span><i class="legend-dot reserved" />IP Reservation</span>
      <span><i class="legend-dot system" />System</span>
    </div>
    <div
      v-else-if="activeView === 'addresses'"
      class="address-overview"
      aria-label="Address utilization"
    >
      <div>
        <span :style="{ '--value': addressOverview.assignedPercent }" /><small>Assigned</small
        ><strong>{{ addressOverview.assigned }}</strong>
      </div>
      <div>
        <span :style="{ '--value': addressOverview.poolPercent }" /><small>DHCP pool</small
        ><strong>{{ addressOverview.pool }}</strong>
      </div>
      <div>
        <span :style="{ '--value': addressOverview.unassignedPercent }" /><small>Unassigned</small
        ><strong>{{ addressOverview.unassigned }}</strong>
      </div>
    </div>
  </section>
</template>

<script setup>
import { formatDuration } from '../networks-workspace-data.js';

// Breadcrumb, gauges, pinned actions, view tabs and the per-view summary band.
// Renders as three sibling landmarks so the DOM under .work-surface is
// unchanged from the single-file layout.
defineProps({
  contextKind: { type: String, required: true },
  contextIcon: { type: String, required: true },
  contextTitle: { type: String, required: true },
  contextSubtitle: { type: String, default: '' },
  selectedFolder: { type: Object, default: null },
  selectedNetwork: { type: Object, required: true },
  stats: { type: Array, required: true },
  canScan: { type: Boolean, default: false },
  hasActions: { type: Boolean, default: false },
  canCreate: { type: Boolean, default: false },
  views: { type: Array, required: true },
  activeView: { type: String, required: true },
  showSummary: { type: Boolean, default: false },
  viewMeta: { type: Object, required: true },
  summaryZones: { type: Array, default: () => [] },
  summaryScopes: { type: Array, default: () => [] },
  addressOverview: { type: Object, required: true },
});
const emit = defineEmits([
  'select-estate',
  'select-folder',
  'switch-view',
  'open-menu',
  'filter-zone',
  'filter-scope',
  'notify',
]);
</script>

<style scoped>
button,
input {
  font: inherit;
}
button {
  color: inherit;
}
.context-header {
  container: workspace-context / inline-size;
  flex-shrink: 0;
  padding: 0.85rem 1rem 0;
  border-bottom: 1px solid var(--preview-line);
}
.context-breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.55rem;
  color: var(--preview-muted);
  font-size: 0.65rem;
}
.context-breadcrumb button {
  padding: 0;
  border: 0;
  color: var(--preview-accent);
  background: none;
  cursor: pointer;
}
.context-breadcrumb i {
  font-size: 0.48rem;
}
.context-overview {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(540px, max-content) auto;
  align-items: center;
  gap: 0.75rem 1.25rem;
}
.context-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 1rem;
}
.context-identity {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}
.context-icon {
  display: inline-flex;
  width: 2.4rem;
  height: 2.4rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.title-line {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.title-line h2 {
  margin: 0;
  font-size: 1.24rem;
  letter-spacing: -0.025em;
}
.context-identity p {
  margin: 0.15rem 0 0;
  color: var(--preview-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.69rem;
}
.state-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.42rem;
  border-radius: 999px;
  color: var(--cid-green-600);
  background: color-mix(in srgb, var(--cid-green-500) 11%, transparent);
  font-size: 0.61rem;
  font-weight: 800;
  text-transform: uppercase;
}
.state-chip i {
  width: 0.36rem;
  height: 0.36rem;
  border-radius: 50%;
  background: var(--cid-green-500);
}
.context-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
}
.button {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  gap: 0.38rem;
  padding: 0 0.68rem;
  border: 1px solid var(--preview-line);
  border-radius: 7px;
  background: var(--cid-surface-card);
  font-size: var(--app-fs-sm);
  font-weight: 700;
  cursor: pointer;
}
.button:hover {
  border-color: color-mix(in srgb, var(--preview-accent) 55%, var(--preview-line));
}
.button.primary {
  border-color: var(--preview-accent);
  color: var(--cid-primary-contrast-color, white);
  background: var(--preview-accent);
}
.health-strip {
  display: flex;
  min-width: 0;
  flex: 1 1 540px;
  justify-content: flex-end;
  gap: 0;
  overflow-x: auto;
}
.health-stat {
  display: grid;
  min-width: 118px;
  padding: 0.58rem 1rem 0.62rem 0;
  border: 0;
  color: inherit;
  background: none;
  text-align: left;
}
.health-stat:disabled {
  opacity: 1;
}
.health-stat.interactive {
  cursor: pointer;
}
.health-stat.interactive:hover strong {
  color: var(--preview-accent);
}
.health-stat + .health-stat {
  padding-left: 1rem;
  border-left: 1px solid var(--preview-line);
}
.health-stat > span {
  color: var(--preview-muted);
  font-size: 0.56rem;
  font-weight: 800;
  letter-spacing: 0.11em;
}
.health-stat strong {
  margin: 0.12rem 0;
  font-size: 0.8rem;
}
.health-stat small {
  display: flex;
  align-items: center;
  gap: 0.28rem;
  color: var(--preview-muted);
  font-size: 0.61rem;
  white-space: nowrap;
}
.health-stat small i {
  width: 0.34rem;
  height: 0.34rem;
  border-radius: 50%;
  background: var(--cid-green-500);
}
.health-stat small.warning {
  color: var(--cid-orange-600);
}
.health-stat small.warning i {
  background: var(--cid-orange-500);
}
@container workspace-context (max-width: 1180px) {
  .context-overview {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .context-title-row {
    grid-column: 1;
    grid-row: 1;
  }
  .context-actions {
    grid-column: 2;
    grid-row: 1;
  }
  .health-strip {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: flex-start;
  }
}
.view-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 0.18rem;
  padding: 0.48rem 0.75rem 0;
  background: color-mix(in srgb, var(--cid-surface-ground) 52%, var(--cid-surface-card));
  border-bottom: 1px solid var(--preview-line);
}
.view-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  padding: 0.5rem 0.68rem 0.56rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--preview-muted);
  font-size: var(--app-fs-sm);
  font-weight: 700;
  cursor: pointer;
}
.view-tabs button.active {
  border-bottom-color: var(--preview-accent);
  color: var(--preview-accent);
}
.view-tabs button span {
  padding: 0.08rem 0.3rem;
  border-radius: 999px;
  background: var(--cid-surface-200);
  color: var(--preview-muted);
  font-size: 0.59rem;
}
.view-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--preview-line);
  background: var(--cid-surface-card);
}
.view-summary h3 {
  margin: 0.1rem 0;
  font-size: 0.96rem;
}
.linked-resources {
  display: flex;
  gap: 0.45rem;
}
.linked-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  max-width: 235px;
  padding: 0.48rem 0.58rem;
  border: 1px solid var(--preview-line);
  border-radius: 8px;
  background: var(--cid-surface-card);
  text-align: left;
  cursor: pointer;
}
.linked-card.selected {
  border-color: color-mix(in srgb, var(--preview-accent) 42%, var(--preview-line));
  background: var(--preview-accent-soft);
}
.linked-card > i {
  color: var(--preview-accent);
}
.linked-card span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.linked-card small {
  color: var(--preview-muted);
  font-size: 0.52rem;
  letter-spacing: 0.09em;
}
.linked-card strong {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.linked-card em {
  color: var(--preview-muted);
  font-size: 0.63rem;
  font-style: normal;
}
.linked-empty {
  align-self: center;
  color: var(--preview-muted);
  font-size: 0.65rem;
}
.address-overview {
  display: flex;
  gap: 0.5rem;
}
.address-overview > div {
  display: grid;
  grid-template-columns: 4px auto;
  grid-template-rows: auto auto;
  column-gap: 0.42rem;
  min-width: 66px;
}
.address-overview > div > span {
  grid-row: 1 / 3;
  display: block;
  width: 4px;
  height: 2rem;
  align-self: center;
  overflow: hidden;
  border-radius: 99px;
  background: var(--cid-surface-200);
}
.address-overview > div > span::after {
  content: '';
  display: block;
  height: var(--value);
  margin-top: calc(2rem - var(--value));
  background: var(--preview-accent);
}
.address-overview small {
  align-self: end;
  color: var(--preview-muted);
  font-size: 0.58rem;
}
.address-overview strong {
  font-size: 0.8rem;
}
.range-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  color: var(--preview-muted);
  font-size: 0.61rem;
}
.range-legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.legend-dot {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 2px;
}
.legend-dot.scope {
  background: var(--preview-accent);
}
.legend-dot.infra {
  background: #22d3ee;
}
.legend-dot.reserved {
  background: var(--preview-dhcp);
}
.legend-dot.system {
  background: var(--cid-surface-500);
}
.context-breadcrumb,
.state-chip,
.health-stat small,
.view-tabs button span,
.view-summary p,
.linked-card small,
.linked-card strong,
.linked-card em,
.linked-empty,
.address-overview small,
.range-legend {
  font-size: var(--workspace-font-small);
}
.context-identity p,
.button,
.health-stat strong,
.view-tabs button {
  font-size: var(--workspace-font-body);
}
@media (max-width: 1100px) {
  .linked-card:nth-child(2) {
    display: none;
  }
}
@media (max-width: 820px) {
  .context-title-row {
    align-items: flex-start;
  }
  .context-actions {
    justify-content: flex-end;
  }
  .view-summary {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
