<template>
  <aside class="resource-explorer">
    <div class="explorer-heading">
      <div>
        <span class="eyebrow">RESOURCE EXPLORER</span>
        <strong>Infrastructure</strong>
      </div>
      <button
        v-if="canCreate"
        class="icon-button"
        title="Create resource"
        aria-label="Create resource"
        @click="emit('create')"
      >
        <i class="pi pi-plus" />
      </button>
    </div>

    <label class="explorer-search">
      <i class="pi pi-search" />
      <input
        v-model="query"
        type="search"
        placeholder="Find networks, hostnames, or IPs"
        aria-label="Find networks, hostnames, or IPs"
        data-track="workspace-global-search"
      />
      <kbd>⌘ K</kbd>
    </label>

    <button
      class="estate-row"
      :class="{ active: contextKind === 'estate' }"
      data-track="workspace-estate-select"
      @click="emit('select-estate')"
    >
      <span class="estate-icon"><i class="pi pi-building" /></span>
      <span
        ><strong>All Networks</strong
        ><small
          >{{ countOf(networkCount, 'network') }} · {{ countOf(zoneCount, 'zone') }} ·
          {{ countOf(scopeCount, 'scope') }}</small
        ></span
      >
      <i class="pi pi-chevron-right" />
    </button>

    <div class="explorer-section-head">
      <span>NETWORK SCOPE</span>
      <button data-track="workspace-unallocated-select" @click="emit('select-unallocated')">
        Browse unallocated
      </button>
    </div>

    <div class="network-tree">
      <section v-for="folder in folders" :key="folder.id" class="network-group">
        <div
          class="folder-row"
          :class="{ active: contextKind === 'folder' && selectedFolderId === folder.id }"
        >
          <button
            class="folder-toggle"
            :aria-label="`${expandedFolders.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.name}`"
            @click="emit('toggle-folder', folder.id)"
          >
            <i
              class="pi"
              :class="expandedFolders.has(folder.id) ? 'pi-chevron-down' : 'pi-chevron-right'"
            />
          </button>
          <button
            class="folder-select"
            data-track="workspace-folder-select"
            @click="emit('select-folder', folder)"
          >
            <i class="pi pi-folder" />
            <span
              ><template v-for="(part, index) in highlightParts(folder.name)" :key="index"
                ><mark v-if="part.match">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></span
            >
            <small>{{ folder.networks.length }}</small>
          </button>
        </div>
        <div v-if="expandedFolders.has(folder.id)" class="folder-networks">
          <template v-if="contextKind === 'unallocated'">
            <ResourceExplorerNode
              v-for="network in folder.networks"
              :key="network.id"
              :node="network"
              :query="query"
              :selected-network-id="selectedNetworkId"
              @select="emit('select-unallocated-network', $event)"
            />
          </template>
          <button
            v-for="network in contextKind === 'unallocated' ? [] : folder.networks"
            :key="network.id"
            class="network-row"
            :class="{ active: contextKind === 'network' && selectedNetworkId === network.id }"
            data-track="workspace-network-select"
            @click="emit('select-network', network)"
          >
            <span class="network-state" :class="network.state" />
            <span class="network-copy">
              <strong
                ><template v-for="(part, index) in highlightParts(network.name)" :key="index"
                  ><mark v-if="part.match">{{ part.text }}</mark
                  ><template v-else>{{ part.text }}</template></template
                ></strong
              >
              <small
                ><template v-for="(part, index) in highlightParts(network.cidr)" :key="index"
                  ><mark v-if="part.match">{{ part.text }}</mark
                  ><template v-else>{{ part.text }}</template></template
                ><template v-if="network.vlan != null"> · VLAN {{ network.vlan }}</template></small
              >
              <span class="mini-meter"><i :style="{ width: `${network.used}%` }" /></span>
            </span>
            <span class="network-percent">{{ network.used }}%</span>
          </button>
        </div>
      </section>
      <div v-if="!loading && !folders.length" class="explorer-empty">
        No {{ contextKind === 'unallocated' ? 'unallocated' : 'allocated' }} networks found.
      </div>
    </div>

    <div v-if="canManageFolders || canManageDefaults" class="explorer-footer">
      <button v-if="canManageFolders" @click="emit('notify', 'Open folder management')">
        <i class="pi pi-folder-plus" /> Manage folders
      </button>
      <button v-if="canManageDefaults" @click="emit('notify', 'Open network defaults')">
        <i class="pi pi-sliders-h" /> Defaults
      </button>
    </div>
  </aside>
</template>

<script setup>
import { countOf } from '../../utils/format.js';
import ResourceExplorerNode from './ResourceExplorerNode.vue';

// Presentation only. Folder/network selection, expansion and the create menu
// are owned by NetworksWorkspace.vue, which passes the derived tree in and
// receives every interaction back as an event.
defineProps({
  contextKind: { type: String, required: true },
  folders: { type: Array, required: true },
  expandedFolders: { type: Set, required: true },
  selectedFolderId: { type: Number, default: null },
  selectedNetworkId: { type: Number, default: null },
  networkCount: { type: Number, default: 0 },
  zoneCount: { type: Number, default: 0 },
  scopeCount: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
  canCreate: { type: Boolean, default: false },
  canManageFolders: { type: Boolean, default: false },
  canManageDefaults: { type: Boolean, default: false },
});
const emit = defineEmits([
  'create',
  'select-estate',
  'select-unallocated',
  'select-folder',
  'select-network',
  'select-unallocated-network',
  'toggle-folder',
  'notify',
]);
const query = defineModel('query', { type: String, default: '' });

function highlightParts(value) {
  const text = String(value || '');
  const needle = query.value.trim();
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
.resource-explorer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--preview-line);
  background: color-mix(in srgb, var(--cid-surface-ground) 65%, var(--cid-surface-card));
}
.explorer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 0.9rem 0.7rem;
}
.explorer-heading > div {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}
.explorer-heading strong {
  font-size: 1rem;
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
.explorer-search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--preview-line);
  background: var(--cid-surface-card);
}
.explorer-search {
  margin: 0 0.75rem 0.8rem;
  padding: 0 0.55rem;
  min-height: 2.25rem;
  border-radius: 8px;
}
.explorer-search i {
  color: var(--preview-muted);
  font-size: 0.78rem;
}
.explorer-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--cid-text-color);
  font-size: var(--app-fs-sm);
}
.explorer-search kbd {
  padding: 0.12rem 0.3rem;
  border: 1px solid var(--preview-line);
  border-radius: 4px;
  color: var(--preview-muted);
  background: var(--cid-surface-ground);
  font-size: 0.62rem;
}
.estate-row {
  display: grid;
  grid-template-columns: 2rem 1fr auto;
  align-items: center;
  gap: 0.55rem;
  margin: 0 0.55rem 0.65rem;
  padding: 0.55rem;
  border: 1px solid var(--preview-line);
  border-radius: 9px;
  text-align: left;
  background: var(--cid-surface-card);
  cursor: pointer;
}
.estate-row:hover,
.estate-row.active {
  border-color: color-mix(in srgb, var(--preview-accent) 45%, var(--preview-line));
  background: var(--preview-accent-soft);
}
.estate-row > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.12rem;
}
.estate-row strong {
  font-size: var(--app-fs-sm);
}
.estate-row small {
  overflow: hidden;
  color: var(--preview-muted);
  font-size: 0.63rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.estate-row > .pi-chevron-right {
  color: var(--preview-muted);
  font-size: 0.6rem;
}
.estate-icon {
  display: inline-flex;
  width: 1.85rem;
  height: 1.85rem;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--preview-accent);
  background: var(--preview-accent-soft);
}
.explorer-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.75rem 0.35rem;
  color: var(--preview-muted);
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.12em;
}
.explorer-section-head button {
  padding: 0;
  border: 0;
  color: var(--preview-accent);
  background: none;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0;
  cursor: pointer;
}
.network-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0.45rem;
}
.explorer-empty {
  padding: 1rem 0.7rem;
  color: var(--preview-muted);
  font-size: var(--app-fs-sm);
  text-align: center;
}
.network-group + .network-group {
  margin-top: 0.18rem;
}
.folder-row {
  display: grid;
  grid-template-columns: 1.25rem 1fr;
  width: 100%;
  align-items: center;
  padding: 0.12rem;
  border-radius: 7px;
  color: var(--preview-muted);
}
.folder-row:hover,
.folder-row.active {
  background: var(--preview-accent-soft);
}
.folder-row.active {
  box-shadow: inset 3px 0 var(--preview-accent);
}
.folder-toggle,
.folder-select {
  border: 0;
  background: none;
  cursor: pointer;
}
.folder-toggle {
  display: inline-flex;
  width: 1.25rem;
  height: 1.8rem;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--preview-muted);
}
.folder-toggle i {
  font-size: 0.52rem;
}
.folder-select {
  display: grid;
  grid-template-columns: 0.9rem 1fr auto;
  align-items: center;
  gap: 0.38rem;
  min-width: 0;
  padding: 0.3rem 0.3rem 0.3rem 0;
  color: var(--preview-muted);
  text-align: left;
}
.folder-select span {
  overflow: hidden;
  color: var(--cid-text-color);
  font-size: var(--app-fs-sm);
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-select small {
  font-size: 0.65rem;
}
.folder-networks {
  display: grid;
  gap: 0.16rem;
  margin-bottom: 0.3rem;
}
.network-row {
  display: grid;
  grid-template-columns: 0.5rem 1fr auto;
  align-items: start;
  gap: 0.5rem;
  width: 100%;
  padding: 0.48rem 0.45rem 0.48rem 1.05rem;
  border: 0;
  border-radius: 8px;
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
  box-shadow:
    inset 3px 0 var(--preview-accent),
    inset 0 0 0 1px var(--preview-line);
}
.network-state {
  width: 0.42rem;
  height: 0.42rem;
  margin-top: 0.32rem;
  border-radius: 50%;
  background: var(--cid-green-500);
}
.network-state.warning {
  background: var(--cid-orange-500);
}
.network-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.1rem;
}
.network-copy strong {
  overflow: hidden;
  font-size: var(--app-fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-copy small {
  overflow: hidden;
  color: var(--preview-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-meter {
  height: 2px;
  margin-top: 0.22rem;
  overflow: hidden;
  border-radius: 99px;
  background: var(--cid-surface-200);
}
.mini-meter i {
  display: block;
  height: 100%;
  background: var(--preview-accent);
}
.network-percent {
  padding-top: 0.12rem;
  color: var(--preview-muted);
  font-size: 0.62rem;
  font-weight: 700;
}
.explorer-footer {
  display: flex;
  justify-content: space-between;
  gap: 0.3rem;
  padding: 0.65rem;
  border-top: 1px solid var(--preview-line);
}
.explorer-footer button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem;
  border: 0;
  background: none;
  color: var(--preview-muted);
  font-size: 0.65rem;
  cursor: pointer;
}
.explorer-footer button:hover {
  color: var(--preview-accent);
}
mark {
  border-radius: 2px;
  background: color-mix(in srgb, var(--preview-dns) 35%, transparent);
  color: inherit;
}
.eyebrow,
.estate-row small,
.explorer-section-head,
.explorer-section-head button,
.folder-select small,
.network-percent,
.explorer-footer button {
  font-size: var(--workspace-font-small);
}
.explorer-search input,
.estate-row strong,
.explorer-empty,
.folder-select span,
.network-copy strong,
.network-copy small {
  font-size: var(--workspace-font-body);
}
@media (max-width: 820px) {
  .resource-explorer {
    display: none;
  }
}
</style>
