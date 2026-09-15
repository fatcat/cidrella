<template>
  <AddressDetailsPanel
    v-if="row && rowView === 'addresses' && rowContext === 'network'"
    :row="row"
    :subnet-id="network.id"
    :network-name="network.name"
    :dns-count="dnsCount"
    :dhcp-count="dhcpCount"
    :can-write="canWrite"
    @close="emit('close')"
    @navigate="emit('navigate', $event)"
    @changed="emit('changed', $event)"
  />

  <aside v-else-if="row" class="details-panel">
    <div class="details-head">
      <div>
        <span class="eyebrow">DETAILS</span><strong>{{ title }}</strong>
      </div>
      <button class="icon-button" aria-label="Close details" @click="emit('close')">
        <i class="pi pi-times" />
      </button>
    </div>
    <div class="details-status">
      <span class="detail-orb" :class="row.online || 'unknown'"><i :class="icon" /></span>
      <div>
        <strong>{{ heading }}</strong
        ><small>{{ subheading }}</small>
      </div>
    </div>
    <dl>
      <template v-for="item in items" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value || EMPTY_CELL }}</dd>
      </template>
    </dl>
    <div v-if="related.length" class="details-section">
      <span class="eyebrow">RELATED RESOURCES</span>
      <button
        v-for="resource in related"
        :key="resource.label"
        @click="emit('navigate', resource.view)"
      >
        <i :class="resource.icon" /><span
          ><strong>{{ resource.label }}</strong
          ><small>{{ resource.note }}</small></span
        ><i class="pi pi-chevron-right" />
      </button>
    </div>
    <div v-if="actions.length" class="details-section">
      <span class="eyebrow">QUICK ACTIONS</span>
      <div class="quick-actions">
        <button
          v-for="action in actions"
          :key="action.id"
          :class="{ danger: action.danger }"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { EMPTY_CELL } from '../../utils/format.js';
import AddressDetailsPanel from './AddressDetailsPanel.vue';

// Chooses between the live address panel and the generic resource summary.
// The row identity still lives in NetworksWorkspace.vue for now; owning it
// here independently of the active table is W-05/W-06 work.
defineProps({
  row: { type: Object, default: null },
  rowView: { type: String, default: 'addresses' },
  rowContext: { type: String, default: 'network' },
  canWrite: { type: Boolean, default: false },
  network: { type: Object, required: true },
  dnsCount: { type: Number, default: 0 },
  dhcpCount: { type: Number, default: 0 },
  title: { type: String, default: '' },
  heading: { type: String, default: '' },
  subheading: { type: String, default: '' },
  icon: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  related: { type: Array, default: () => [] },
  actions: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'navigate', 'changed', 'action']);
</script>

<style scoped>
button,
input {
  font: inherit;
}
button {
  color: inherit;
}
.eyebrow {
  color: var(--preview-accent);
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.icon-button {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.icon-button:hover {
  background: var(--preview-accent-soft);
  color: var(--preview-accent);
}
.details-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  display: flex;
  width: min(330px, 90%);
  flex-direction: column;
  overflow-y: auto;
  border-left: 1px solid var(--preview-line);
  background: var(--cid-surface-card);
  box-shadow: -12px 0 32px rgba(15, 23, 42, 0.13);
}
.details-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem;
  border-bottom: 1px solid var(--preview-line);
}
.details-head > div {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.details-head strong {
  font-size: 0.9rem;
}
.details-status {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.9rem;
  border-bottom: 1px solid var(--preview-line);
}
.detail-orb {
  display: inline-flex;
  width: 2.5rem;
  height: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--cid-green-600);
  background: color-mix(in srgb, var(--cid-green-500) 12%, transparent);
}
.detail-orb.offline,
.detail-orb.unknown {
  color: var(--preview-muted);
  background: var(--cid-surface-ground);
}
.details-status > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.14rem;
}
.details-status strong {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
.details-status small {
  overflow: hidden;
  color: var(--preview-muted);
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.details-panel dl {
  display: grid;
  grid-template-columns: 42% 58%;
  margin: 0;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--preview-line);
  font-size: 0.66rem;
}
.details-panel dt,
.details-panel dd {
  padding: 0.33rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent);
}
.details-panel dt {
  color: var(--preview-muted);
}
.details-panel dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.details-section {
  display: grid;
  gap: 0.42rem;
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--preview-line);
}
.details-section > button {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.48rem;
  border: 1px solid var(--preview-line);
  border-radius: 7px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.details-section > button:hover {
  border-color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.details-section > button > i:first-child {
  color: var(--preview-accent);
}
.details-section > button > i:last-child {
  color: var(--preview-muted);
  font-size: 0.55rem;
}
.details-section > button span {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.details-section > button strong {
  font-size: 0.67rem;
}
.details-section > button small {
  color: var(--preview-muted);
  font-size: 0.6rem;
}
.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.32rem;
}
.quick-actions button {
  padding: 0.32rem 0.45rem;
  border: 1px solid var(--preview-line);
  border-radius: 6px;
  background: transparent;
  font-size: 0.61rem;
  cursor: pointer;
}
.quick-actions button:hover {
  color: var(--preview-accent);
  border-color: var(--preview-accent);
}
.activity-link {
  display: flex;
  align-items: center;
  gap: 0.38rem;
  margin: auto 0.9rem 0.9rem;
  padding: 0.52rem;
  border: 0;
  background: none;
  color: var(--preview-accent);
  font-size: 0.66rem;
  font-weight: 700;
  cursor: pointer;
}
.eyebrow,
.details-status small,
.details-section > button small {
  font-size: var(--workspace-font-small);
}
.details-head strong,
.details-status strong,
.details-panel dl,
.details-section > button strong,
.quick-actions button,
.activity-link {
  font-size: var(--workspace-font-body);
}
@media (max-width: 820px) {
  .details-panel {
    position: fixed;
  }
}
</style>
