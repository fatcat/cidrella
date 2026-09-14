<template>
  <div class="resource-node" :class="{ container: !node.allocatable }">
    <button
      class="network-row"
      :class="{ active: node.allocatable && selectedNetworkId === node.id }"
      :disabled="!node.allocatable"
      :aria-label="node.allocatable ? `Select ${node.cidr}` : `${node.cidr} subdivided container`"
      data-track="workspace-network-select"
      @click="node.allocatable && emit('select', node)"
    >
      <span class="network-state" :class="node.state" />
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
          <template v-if="!node.allocatable"> · subdivided</template>
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
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'ResourceExplorerNode' });
const props = defineProps({
  node: { type: Object, required: true },
  query: { type: String, default: '' },
  selectedNetworkId: { type: Number, default: null },
});
const emit = defineEmits(['select']);

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
.network-state {
  width: 0.42rem;
  height: 0.42rem;
  margin-top: 0.32rem;
  border-radius: 50%;
  background: var(--cid-green-500);
}
.network-state.container {
  background: var(--preview-muted);
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
