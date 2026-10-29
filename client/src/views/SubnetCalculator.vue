<template>
  <div class="subnet-calc" style="display: flex; flex-direction: column; height: 100%">
    <h2>Network Calculator</h2>
    <p class="subtitle">Split a network into smaller networks or calculate network details.</p>

    <div class="calc-form">
      <div class="field">
        <label>CIDR Notation</label>
        <InputText v-model="cidr" placeholder="10.0.0.0/16" @keyup.enter="calculate" />
      </div>
      <div class="field">
        <label>Split into /</label>
        <InputNumber v-model="newPrefix" :min="1" :max="maxPrefix" />
      </div>
      <Button label="Calculate" icon="pi pi-calculator" @click="calculate" :loading="loading" />
    </div>

    <!-- Parent info -->
    <div class="parent-info" v-if="parent">
      <h3>Parent Network</h3>
      <div class="info-grid">
        <div><span class="lbl">Network:</span> {{ parent.network }}/{{ parent.prefix }}</div>
        <div v-if="parent.mask"><span class="lbl">Mask:</span> {{ parent.mask }}</div>
        <div v-if="parent.broadcast">
          <span class="lbl">Broadcast:</span> {{ parent.broadcast }}
        </div>
        <div>
          <span class="lbl">Total IPs:</span>
          {{ formatCount(parent.totalAddresses ?? parent.size) }}
        </div>
        <div>
          <span class="lbl">Usable:</span> {{ formatCount(parent.usableCount ?? parent.usable) }}
        </div>
        <div>
          <span class="lbl">Range:</span> {{ parent.firstUsable }} – {{ parent.lastUsable }}
        </div>
      </div>
    </div>

    <!-- Split results: a page at a time, so a /48 into /64s never sits in the
         browser whole. -->
    <div class="results" v-if="totalCount">
      <h3>
        {{ formatCount(totalCount) }} Network{{ totalCount > 1 ? 's' : '' }} (each /{{
          resultPrefix
        }}), {{ firstChild }} to {{ lastChild }}
      </h3>
      <DataTable
        :value="subnets"
        lazy
        :totalRecords="totalCount"
        :first="pageFirst"
        stripedRows
        size="small"
        :paginator="totalCount > pageRows"
        :rows="pageRows"
        :rowsPerPageOptions="[64, 128, 256, 512]"
        :loading="loading"
        scrollable
        scrollHeight="flex"
        @page="onPage"
        @row-contextmenu="onRowContextMenu"
        :contextMenu="true"
        v-model:contextMenuSelection="contextRow"
      >
        <Column header="#" style="width: 5rem">
          <template #body="{ index }">{{ (pageFirst + index + 1).toLocaleString() }}</template>
        </Column>
        <Column header="Network">
          <template #body="{ data }">{{ data.network }}/{{ data.prefix }}</template>
        </Column>
        <Column v-if="parentFamily !== 6" field="mask" header="Mask" />
        <Column field="firstUsable" header="First Usable" />
        <Column field="lastUsable" header="Last Usable" />
        <Column v-if="parentFamily !== 6" field="broadcast" header="Broadcast" />
        <Column header="Usable IPs">
          <template #body="{ data }">{{ formatCount(data.usableCount ?? data.usable) }}</template>
        </Column>
      </DataTable>
      <ContextMenu ref="contextMenuRef" :model="contextMenuItems" />
    </div>

    <div class="error-msg" v-if="error">{{ error }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import ContextMenu from '../ui/ContextMenu.js';
import { useSubnetStore } from '../stores/subnets.js';
import { apiError } from '../utils/format.js';
import { loadJson, saveJson } from '../utils/storage.js';
import { maxPrefixFor, cidrFamily } from '../utils/ip.js';

const STORAGE_KEY = 'cidrella-subnet-calc';
const store = useSubnetStore();
const toast = useToast();
const contextMenuRef = ref(null);
const contextRow = ref(null);

// Only the inputs are remembered; the result is asked for again.
const saved = loadJson(STORAGE_KEY, null);
const cidr = ref(saved?.cidr || '');
const newPrefix = ref(saved?.newPrefix ?? 24);
const parent = ref(null);
const subnets = ref([]);
const totalCount = ref(0);
const firstChild = ref('');
const lastChild = ref('');
// The split on screen, kept apart from the inputs a person may be editing.
let resultCidr = '';
const resultPrefix = ref(null);
const pageFirst = ref(0);
const pageRows = ref(256);
const loading = ref(false);
const error = ref('');

// 32 or 128 by the family of what is typed; the server refuses the rest.
const maxPrefix = computed(() => maxPrefixFor(cidr.value));
const parentFamily = computed(() =>
  parent.value ? cidrFamily(`${parent.value.network}/${parent.value.prefix}`) : null,
);

// Counts arrive as numbers, as strings above 2^53, or null for a prefix too
// large to count; each reads sensibly.
function formatCount(value) {
  if (value === null || value === undefined) return 'more than 2^53';
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(n) ? n.toLocaleString() : String(value);
}

async function loadPage(page) {
  const result = await store.calculateSubnets(resultCidr, resultPrefix.value, {
    page,
    pageSize: pageRows.value,
  });
  parent.value = result.parent;
  subnets.value = result.subnets;
  // At most 65,536 children: the count fits a number.
  totalCount.value = Number(result.count);
  firstChild.value = result.first;
  lastChild.value = result.last;
  pageFirst.value = (page - 1) * pageRows.value;
}

async function calculate() {
  if (!cidr.value) return;
  loading.value = true;
  error.value = '';
  resultCidr = cidr.value;
  resultPrefix.value = newPrefix.value;
  try {
    await loadPage(1);
    saveJson(STORAGE_KEY, { cidr: cidr.value, newPrefix: newPrefix.value });
  } catch (err) {
    error.value = apiError(err);
    parent.value = null;
    subnets.value = [];
    totalCount.value = 0;
  } finally {
    loading.value = false;
  }
}

async function onPage(event) {
  pageRows.value = event.rows;
  loading.value = true;
  try {
    await loadPage(event.page + 1);
  } catch (err) {
    error.value = apiError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (cidr.value) void calculate();
});

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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}
</script>

<style scoped>
.subnet-calc h2 {
  margin: 0;
}
.subtitle {
  color: var(--cid-text-muted-color);
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
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}
.parent-info h3 {
  margin: 0 0 0.5rem 0;
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.35rem;
  font-family: monospace;
  font-size: 0.9rem;
}
.lbl {
  color: var(--cid-text-muted-color);
  font-family: inherit;
}
.results {
  margin-top: 1rem;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-bottom: 1.1rem;
}
.results h3 {
  margin: 0 0 0.75rem 0;
}
.error-msg {
  margin-top: 1rem;
  color: var(--cid-red-500);
  font-weight: 600;
}
</style>
