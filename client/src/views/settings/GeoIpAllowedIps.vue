<!--
  Filtering › Allowed IPs: the GeoIP IP/CIDR allowlist as its own settings
  sub-tab. Extracted from GeoIP.vue's inner "Allowed IPs" TabPanel when the
  Filtering area's nested tabs were flattened (v0.4.16). Entries here are
  never GeoIP-blocked; the server stores them in canonical CIDR form.
-->
<template>
  <div class="allowed-ips" style="display: flex; flex-direction: column; height: 100%;">
    <p class="wl-hint">
      IP addresses or CIDR ranges here are <strong>never</strong> GeoIP-blocked, regardless of the
      resolved country. Use it for known-good servers/ranges in an otherwise-blocked country. (To always
      allow a whole <em>domain</em>, use Filtering › Allowed Domains instead.)
    </p>
    <div class="ip-allow-add">
      <InputText v-model="newIp" placeholder="e.g. 203.0.113.0/24 or 2001:db8::/32"
                 class="ip-allow-input" @keyup.enter="doAddIp" />
      <InputText v-model="newIpReason" placeholder="Reason (optional)" class="ip-allow-reason" />
      <Button label="Add" icon="pi pi-plus" size="small" :loading="addingIp" @click="doAddIp"
              data-track="geoip-add-allow-ip" />
    </div>
    <DataTable :value="store.ipAllowlist" stripedRows size="small"
               scrollable scrollHeight="flex">
      <template #empty>
        <EmptyState icon="pi-shield" title="No allowed IPs or ranges" description="Addresses listed here are never GeoIP-blocked." />
      </template>
      <Column field="value" header="IP / CIDR" sortable />
      <Column field="reason" header="Reason">
        <template #body="{ data }">{{ data.reason || EMPTY_CELL }}</template>
      </Column>
      <Column header="" style="width: 4rem">
        <template #body="{ data }">
          <Button icon="pi pi-trash" severity="danger" text rounded size="small" @click="doRemoveIp(data)" />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useToast } from '../../ui/useToast.js';
import Button from '../../ui/Button.js';
import InputText from '../../ui/InputText.js';
import DataTable from '../../ui/DataTable.js';
import Column from '../../ui/Column.js';
import EmptyState from '../../components/EmptyState.vue';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import { useGeoipStore } from '../../stores/geoip.js';

const store = useGeoipStore();
const toast = useToast();

const newIp = ref('');
const newIpReason = ref('');
const addingIp = ref(false);

async function doAddIp() {
  const v = newIp.value.trim();
  if (!v) return;
  addingIp.value = true;
  try {
    await store.addIpAllow(v, newIpReason.value.trim() || null);
    newIp.value = ''; newIpReason.value = '';
    toast.add({ severity: 'success', summary: 'IP allowlisted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    addingIp.value = false;
  }
}

async function doRemoveIp(entry) {
  try {
    await store.removeIpAllow(entry.id);
    toast.add({ severity: 'success', summary: 'Removed from allowlist', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(() => store.fetchIpAllowlist());
</script>

<style scoped>
.ip-allow-add { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.ip-allow-input { width: 18rem; }
.ip-allow-reason { width: 14rem; }
.wl-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0 0 0.75rem; line-height: 1.4; }
</style>
