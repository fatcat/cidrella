<!--
  Filtering › Allowed Domains: the shared domain whitelist (exempts a
  domain from BOTH category blocking and GeoIP). Extracted from
  Blocklists.vue's inner "Allowed Domains" TabPanel when the Filtering
  area's nested tabs were flattened (v0.4.16). One backend list:
  /api/blocklists/whitelist.
-->
<template>
  <div class="allowed-domains" style="display: flex; flex-direction: column; height: 100%;">
    <p class="wl-hint">
      Domains here are <strong>never</strong> blocked, by category blocking <em>or</em> GeoIP.
      (To allow specific IPs/ranges regardless of country, use Filtering › Allowed IPs.)
    </p>
    <DomainWhitelist :items="store.whitelist" :on-add="wlAdd" :on-remove="wlRemove"
                     add-track="blocklist-add-allowed-domain"
                     empty-message="No allowed domains." />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { useToast } from '../../ui/useToast.js';
import DomainWhitelist from '../../components/DomainWhitelist.vue';
import { apiError } from '../../utils/format.js';
import { useBlocklistStore } from '../../stores/blocklists.js';

const store = useBlocklistStore();
const toast = useToast();

async function wlAdd(domain, reason) {
  try {
    await store.addWhitelist(domain, reason);
    toast.add({ severity: 'success', summary: 'Domain allowed', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function wlRemove(entry) {
  try {
    await store.removeWhitelist(entry.id);
    toast.add({ severity: 'success', summary: 'Domain removed', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

onMounted(() => store.fetchWhitelist());
</script>

<style scoped>
.wl-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0 0 0.75rem; line-height: 1.4; }
</style>
