<!--
  Shared whitelist for the Filtering area. There is ONE backend allowlist
  (/api/blocklists/whitelist) consulted by both category blocking and GeoIP, so
  this single sub-tab is the only editor (the per-panel Whitelist tabs were removed
  from Blocklists.vue / GeoIP.vue in SET-3). Bound to the blocklists store; refetch
  on (re)activation so it's always fresh regardless of which area you came from.
-->
<template>
  <div class="filtering-whitelist">
    <p class="wl-hint">
      A single shared allowlist — domains here are never blocked by category blocking
      <em>or</em> GeoIP filtering.
    </p>
    <DomainWhitelist :items="store.whitelist" :on-add="wlAdd" :on-remove="wlRemove"
                     add-track="settings-whitelist-add" empty-message="No whitelisted domains." />
  </div>
</template>

<script setup>
import { onMounted, onActivated } from 'vue';
import DomainWhitelist from '../../components/DomainWhitelist.vue';
import { useBlocklistStore } from '../../stores/blocklists.js';
import { useToast } from 'primevue/usetoast';
import { apiError } from '../../utils/format.js';

const store = useBlocklistStore();
const toast = useToast();

async function load() {
  try { await store.fetchWhitelist(); } catch { /* surfaced elsewhere */ }
}

async function wlAdd(domain, reason) {
  try {
    await store.addWhitelist(domain, reason);
    toast.add({ severity: 'success', summary: 'Domain whitelisted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function wlRemove(entry) {
  try {
    await store.removeWhitelist(entry.id);
    toast.add({ severity: 'success', summary: 'Removed from whitelist', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.filtering-whitelist { max-width: 48rem; }
.wl-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0 0 0.75rem; line-height: 1.4; }
</style>
