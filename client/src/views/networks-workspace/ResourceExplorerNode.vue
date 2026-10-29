<template>
  <div class="resource-node" :class="{ container: !node.allocatable }">
    <button
      class="network-row"
      :class="{
        active: node.allocatable && selectedNetworkId === node.id,
        checked: node.allocatable && selectedRows.includes(`network:${node.id}`),
      }"
      :aria-disabled="node.allocatable ? undefined : 'true'"
      :aria-label="
        node.allocatable ? `Select ${node.cidr}` : `${node.cidr} container, ${coverageText}`
      "
      :title="node.coverage ? formatCoverageCounts(node.coverage) : undefined"
      data-track="workspace-network-select"
      :data-network-id="node.id"
      @mousedown="$event.shiftKey && $event.preventDefault()"
      @click="node.allocatable && emit('pick', node, $event)"
      @contextmenu.prevent="emit('menu', node, $event.currentTarget, $event)"
      @keydown="menuKey"
    >
      <StatusDot
        :kind="networkStateKind(node.state)"
        :label="node.state"
        decorative
        class="network-state"
      />
      <span class="network-copy">
        <strong>
          <template v-for="(part, index) in highlight(node.name || node.cidr)" :key="index">
            <mark v-if="part.match">{{ part.text }}</mark
            ><template v-else>{{ part.text }}</template>
          </template>
        </strong>
        <small>
          <template v-for="(part, index) in highlight(node.cidr)" :key="index">
            <mark v-if="part.match">{{ part.text }}</mark
            ><template v-else>{{ part.text }}</template>
          </template>
          <template v-if="!node.allocatable"> · {{ coverageText }}</template>
        </small>
      </span>
      <i v-if="node.children?.length" class="pi pi-chevron-down" />
    </button>
    <div v-if="node.children?.length" class="resource-node-children">
      <ResourceExplorerNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :query="query"
        :selected-network-id="selectedNetworkId"
        :selected-rows="selectedRows"
        @pick="(child, event) => emit('pick', child, event)"
        @menu="(child, invoker, event) => emit('menu', child, invoker, event)"
      />
    </div>
  </div>
</template>

<script setup>
import StatusDot from '../../components/StatusDot.vue';
import { computed } from 'vue';
import {
  formatCoverageCounts,
  formatCoveragePercent,
  networkStateKind,
} from '../networks-workspace-data.js';

defineOptions({ name: 'ResourceExplorerNode' });
const props = defineProps({
  node: { type: Object, required: true },
  query: { type: String, default: '' },
  selectedNetworkId: { type: Number, default: null },
  selectedRows: { type: Array, default: () => [] },
});
// pick: a click, with its event so the explorer can read Ctrl and Shift.
// menu: a right-click or the menu key, as on the explorer's other rows.
const emit = defineEmits(['pick', 'menu']);

// A container reads how much of it is allocated (docs/IPV6-HANDLING.md, rule 3).
const coverageText = computed(() =>
  props.node.coverage
    ? `${formatCoveragePercent(props.node.coverage.percent)} allocated`
    : 'subdivided',
);

// A container's menu offers planning in it (Allocate next free prefix).
function menuKey(event) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('menu', props.node, event.currentTarget);
  }
}

function highlight(value) {
  const text = String(value || '');
  const needle = props.query.trim();
  if (!needle) return [{ text, match: false }];
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, index), match: false },
    { text: text.slice(index, index + needle.length), match: true },
    { text: text.slice(index + needle.length), match: false },
  ].filter((part) => part.text);
}
</script>

<style scoped>
.network-row {
  display: grid;
  grid-template-columns: 0.5rem 1fr auto;
  align-items: start;
  gap: 0.5rem;
  width: 100%;
  padding: 0.48rem 0.45rem 0.48rem 1.05rem;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.network-row:hover,
.network-row.active {
  background: var(--cid-surface-card);
  box-shadow: inset 0 0 0 1px var(--preview-line);
}
.network-row.active {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--preview-accent) 45%, var(--preview-line));
}
.network-state {
  margin-top: 0.32rem;
}
.network-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.1rem;
}
.network-copy strong,
.network-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-copy strong {
  font-size: var(--app-fs-sm);
}
.network-copy small {
  color: var(--preview-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
}
.resource-node-children {
  padding-left: 0.8rem;
  border-left: 1px solid var(--preview-line);
}
.resource-node.container > .network-row {
  cursor: default;
  opacity: 0.75;
}
</style>
