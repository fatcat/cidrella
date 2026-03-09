<template>
  <div class="subnet-calc" style="display: flex; flex-direction: column; height: 100%;">
    <h2>Network Calculator</h2>
    <p class="subtitle">Split a network into smaller networks or calculate network details.</p>

    <div class="calc-form">
      <div class="field">
        <label>CIDR Notation</label>
        <InputText v-model="cidr" placeholder="10.0.0.0/16" @keyup.enter="calculate" />
      </div>
      <div class="field">
        <label>Split into /</label>
        <InputNumber v-model="newPrefix" :min="1" :max="32" />
      </div>
      <Button label="Calculate" icon="pi pi-calculator" @click="calculate" :loading="loading" />
    </div>

    <!-- Parent info -->
    <div class="parent-info" v-if="parent">
      <h3>Parent Network</h3>
      <div class="info-grid">
        <div><span class="lbl">Network:</span> {{ parent.network }}/{{ parent.prefix }}</div>
        <div><span class="lbl">Mask:</span> {{ parent.mask }}</div>
        <div><span class="lbl">Broadcast:</span> {{ parent.broadcast }}</div>
        <div><span class="lbl">Total IPs:</span> {{ parent.totalAddresses.toLocaleString() }}</div>
        <div><span class="lbl">Usable:</span> {{ parent.usableCount.toLocaleString() }}</div>
        <div><span class="lbl">Range:</span> {{ parent.firstUsable }} – {{ parent.lastUsable }}</div>
      </div>
    </div>

    <!-- Split results -->
    <div class="results" v-if="subnets.length">
      <h3>{{ subnets.length }} Network{{ subnets.length > 1 ? 's' : '' }} (each /{{ newPrefix }})</h3>
      <DataTable :value="subnets" stripedRows size="small"
                 :paginator="subnets.length > 256" :rows="256"
                 :rowsPerPageOptions="[64, 128, 256, 512]" scrollable scrollHeight="flex"
                 @row-contextmenu="onRowContextMenu" :contextMenu="true" v-model:contextMenuSelection="contextRow">
        <Column header="#" style="width: 3rem">
          <template #body="{ index }">{{ index + 1 }}</template>
        </Column>
        <Column header="Network">
          <template #body="{ data }">{{ data.network }}/{{ data.prefix }}</template>
        </Column>
        <Column field="mask" header="Mask" />
        <Column field="firstUsable" header="First Usable" />
        <Column field="lastUsable" header="Last Usable" />
        <Column field="broadcast" header="Broadcast" />
        <Column header="Usable IPs">
          <template #body="{ data }">{{ data.usableCount.toLocaleString() }}</template>
        </Column>
      </DataTable>
      <ContextMenu ref="contextMenuRef" :model="contextMenuItems" />
    </div>

    <div class="error-msg" v-if="error">{{ error }}</div>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import ContextMenu from 'primevue/contextmenu';
import Toast from 'primevue/toast';
import { useSubnetStore } from '../stores/subnets.js';

const STORAGE_KEY = 'ipam-subnet-calc';
const store = useSubnetStore();
const toast = useToast();
const contextMenuRef = ref(null);
const contextRow = ref(null);

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

const saved = loadSaved();
const cidr = ref(saved?.cidr || '');
const newPrefix = ref(saved?.newPrefix ?? 24);
const parent = ref(saved?.parent || null);
const subnets = ref(saved?.subnets || []);
const loading = ref(false);
const error = ref('');

async function calculate() {
  if (!cidr.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await store.calculateSubnets(cidr.value, newPrefix.value);
    parent.value = result.parent;
    subnets.value = result.subnets;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cidr: cidr.value, newPrefix: newPrefix.value,
      parent: result.parent, subnets: result.subnets
    }));
  } catch (err) {
    error.value = err.response?.data?.error || err.message;
    parent.value = null;
    subnets.value = [];
  } finally {
    loading.value = false;
  }
}

// ── Context menu ──
function onRowContextMenu(event) {
  contextMenuRef.value.show(event.originalEvent);
}

const contextMenuItems = computed(() => {
  const row = contextRow.value;
  if (!row) return [];
  return [
    {
      label: 'Add Network',
      icon: 'pi pi-plus',
      command: () => addNetwork(row),
    },
  ];
});

async function addNetwork(row) {
  const networkCidr = `${row.network}/${row.prefix}`;
  try {
    await store.createSupernet({ cidr: networkCidr });
    toast.add({ severity: 'success', summary: 'Network added', detail: networkCidr, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}
</script>

<style scoped>
.subnet-calc h2 { margin: 0; }
.subtitle {
  color: var(--p-text-muted-color);
  margin: 0.25rem 0 1.5rem 0;
}
.calc-form {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
  margin-bottom: 2rem;
  flex-wrap: wrap;
}
.calc-form .field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.parent-info {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}
.parent-info h3 { margin: 0 0 0.5rem 0; }
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.35rem;
  font-family: monospace;
  font-size: 0.9rem;
}
.lbl {
  color: var(--p-text-muted-color);
  font-family: inherit;
}
.results { margin-top: 1rem; flex: 1; min-height: 0; display: flex; flex-direction: column; margin-bottom: 1.1rem; }
.results h3 { margin: 0 0 0.75rem 0; }
.error-msg {
  margin-top: 1rem;
  color: var(--p-red-500);
  font-weight: 600;
}
</style>
