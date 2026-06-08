<!--
  Reusable domain-whitelist manager: an add-form (domain + optional reason) plus
  a table of whitelisted domains with remove actions and a right-click menu.
  Used by both the Blocklists and GeoIP whitelist views.

  The parent owns the data + persistence: pass `items` and async `onAdd`/`onRemove`
  handlers (which do the API call + toast). This component manages only its own
  input state, button-loading, and the context menu.
-->
<template>
  <div class="domain-whitelist">
    <div class="settings-row">
      <InputText v-model="newDomain" :placeholder="domainPlaceholder" style="width: 16rem"
                 :data-track="addTrack" @keyup.enter="add" />
      <InputText v-model="newReason" placeholder="Reason (optional)" style="width: 14rem" />
      <Button label="Add" icon="pi pi-plus" size="small" @click="add" :loading="adding" />
    </div>
    <DataTable :value="items" stripedRows size="small" :emptyMessage="emptyMessage"
               :paginator="items.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               @row-contextmenu="onRightClick" contextMenu
               scrollable scrollHeight="flex">
      <Column field="domain" header="Domain" sortable />
      <Column field="reason" header="Reason">
        <template #body="{ data }">{{ data.reason || '—' }}</template>
      </Column>
      <Column field="created_at" header="Added" style="width: 10rem">
        <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
      </Column>
      <Column header="Actions" style="width: 80px">
        <template #body="{ data }">
          <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                  @click="remove(data)" v-tooltip.top="'Remove'" />
        </template>
      </Column>
    </DataTable>
    <ContextMenu ref="ctxRef" :model="ctxItems" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import ContextMenu from 'primevue/contextmenu';
import { formatDateTime } from '../utils/dateFormat.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  onAdd: { type: Function, required: true },     // async (domain, reason) => void
  onRemove: { type: Function, required: true },  // async (item) => void
  domainPlaceholder: { type: String, default: 'domain.com' },
  emptyMessage: { type: String, default: 'No whitelisted domains.' },
  addTrack: { type: String, default: undefined },
});

const formatDate = formatDateTime;
const newDomain = ref('');
const newReason = ref('');
const adding = ref(false);

async function add() {
  if (!newDomain.value.trim()) return;
  adding.value = true;
  try {
    await props.onAdd(newDomain.value.trim(), newReason.value.trim() || undefined);
    newDomain.value = '';
    newReason.value = '';
  } finally {
    adding.value = false;
  }
}

async function remove(item) {
  await props.onRemove(item);
}

const ctxRef = ref();
const selected = ref(null);
const ctxItems = computed(() => selected.value
  ? [{ label: 'Remove from Whitelist', icon: 'pi pi-trash', command: () => remove(selected.value) }]
  : []);
function onRightClick(event) {
  selected.value = event.data;
  ctxRef.value.show(event.originalEvent);
}
</script>
