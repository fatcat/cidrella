<template>
  <Dialog v-model:visible="visible" header="Import from Pi-hole" modal :style="{ width: '32rem' }" data-track="dialog-pihole-import"
          @hide="resetState">
    <div class="pihole-import-step">
      <Tabs :value="piholeTab">
        <TabList>
          <Tab value="online"><i class="pi pi-globe" style="margin-right: 0.3rem" />Online</Tab>
          <Tab value="file"><i class="pi pi-upload" style="margin-right: 0.3rem" />File Upload</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="online">
            <div class="form-grid" style="margin-top: 0.5rem">
              <div class="field">
                <label>Pi-hole URL</label>
                <InputText v-model="piholeUrl" placeholder="http://pihole.local" class="w-full"
                           :class="{ 'pihole-reachable': probeStatus === 'ok', 'pihole-unreachable': probeStatus === 'fail' }" />
                <small v-if="probeStatus === 'fail'" class="field-error">{{ probeError }}</small>
                <small v-if="probeStatus === 'ok' && needsPassword && !piholePassword" class="field-warn">Password required</small>
              </div>
              <div class="field">
                <label>Password (optional)</label>
                <InputText v-model="piholePassword" type="password" class="w-full" placeholder="Leave empty if none" />
              </div>
              <div class="field" style="text-align: right">
                <Button label="Connect" icon="pi pi-download" size="small"
                        @click="fetchConfig" :loading="fetching"
                        :disabled="probeStatus !== 'ok' || (needsPassword && !piholePassword)" />
              </div>
            </div>
          </TabPanel>
          <TabPanel value="file">
            <div class="form-grid" style="margin-top: 0.5rem">
              <div class="field">
                <label>Select pihole.toml</label>
                <input type="file" accept=".toml" @change="onFileSelect" ref="fileInput" />
              </div>
              <div class="field" style="text-align: right" v-if="fileContent">
                <Button label="Parse" icon="pi pi-cog" size="small"
                        @click="parseFile" :loading="parsing" />
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <!-- Preview -->
      <div v-if="preview" class="pihole-preview">
        <h4>Import Preview</h4>
        <div class="preview-summary">
          <div class="preview-item">
            <span class="preview-count">{{ preview.hosts.length }}</span>
            <span class="preview-label">A records</span>
          </div>
          <div class="preview-item">
            <span class="preview-count">{{ preview.cnames.length }}</span>
            <span class="preview-label">CNAME records</span>
          </div>
          <div class="preview-item">
            <span class="preview-count">{{ preview.dhcpHosts.length }}</span>
            <span class="preview-label">DHCP reservations</span>
          </div>
        </div>
        <small v-if="preview.zoneName" class="muted">Zone: {{ preview.zoneName }}</small>
      </div>

      <!-- Import results -->
      <div v-if="importResults" class="pihole-results">
        <Message severity="success" :closable="false">
          Import complete:
          {{ importResults.a.created }} A,
          {{ importResults.cname.created }} CNAME,
          {{ importResults.dhcp.created }} DHCP created
          <template v-if="importResults.dhcp.noSubnet > 0">
            ({{ importResults.dhcp.noSubnet }} DHCP skipped — no matching subnet)
          </template>
        </Message>
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" @click="visible = false" />
      <Button v-if="!importResults" label="Import" icon="pi pi-download"
              @click="executeImport" :loading="importing"
              :disabled="!preview" />
      <Button v-else label="Done" icon="pi pi-check"
              @click="visible = false" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import api from '../api/client.js';

const emit = defineEmits(['imported']);
const toast = useToast();

const visible = ref(false);

const piholeTab = ref('online');
const piholeUrl = ref('');
const piholePassword = ref('');
const probeStatus = ref(null); // null | 'ok' | 'fail'
const probeError = ref('');
const needsPassword = ref(false);
const fetching = ref(false);
const parsing = ref(false);
const importing = ref(false);
const preview = ref(null);
const importResults = ref(null);
const fileContent = ref(null);
const fileInput = ref(null);

function cleanUrl(raw) {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

let probeTimer = null;

async function probe() {
  const url = cleanUrl(piholeUrl.value);
  if (!url) { probeStatus.value = null; return; }
  if (url !== piholeUrl.value.trim()) piholeUrl.value = url;
  try {
    const res = await api.post('/pihole/probe', { url, password: piholePassword.value || undefined });
    if (res.data.reachable) {
      probeStatus.value = 'ok';
      needsPassword.value = res.data.needsPassword;
      probeError.value = '';
    } else {
      probeStatus.value = 'fail';
      probeError.value = res.data.error || 'Could not connect';
    }
  } catch (err) {
    probeStatus.value = 'fail';
    probeError.value = err.response?.data?.error || err.message;
  }
}

watch(piholeUrl, (val) => {
  clearTimeout(probeTimer);
  probeStatus.value = null;
  probeError.value = '';
  const trimmed = val?.trim();
  if (!trimmed) return;
  probeTimer = setTimeout(() => probe(), 600);
});

async function fetchConfig() {
  fetching.value = true;
  try {
    const res = await api.post('/pihole/fetch', {
      url: piholeUrl.value.trim(),
      password: piholePassword.value || undefined
    });
    preview.value = res.data;
    importResults.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Fetch failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { fetching.value = false; }
}

function onFileSelect(event) {
  const file = event.target.files[0];
  if (!file) { fileContent.value = null; return; }
  const reader = new FileReader();
  reader.onload = (e) => { fileContent.value = e.target.result; };
  reader.readAsText(file);
}

async function parseFile() {
  parsing.value = true;
  try {
    const res = await api.post('/pihole/parse', fileContent.value, {
      headers: { 'Content-Type': 'text/plain' }
    });
    preview.value = res.data;
    importResults.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { parsing.value = false; }
}

async function executeImport() {
  if (!preview.value) return;
  importing.value = true;
  try {
    const { useDnsStore } = await import('../stores/dns.js');
    const dnsStore = useDnsStore();
    await dnsStore.fetchZones();
    const domainName = preview.value.zoneName;

    let zone = dnsStore.zones.find(z => z.name === domainName && z.type === 'forward');
    if (!zone && domainName) {
      zone = await dnsStore.createZone({ name: domainName, type: 'forward' });
    }
    if (!zone) {
      toast.add({ severity: 'error', summary: 'No zone found', detail: 'Could not find or create a forward DNS zone for import', life: 5000 });
      return;
    }

    const res = await api.post('/pihole/import', {
      zoneId: zone.id,
      hosts: preview.value.hosts,
      cnames: preview.value.cnames,
      dhcpHosts: preview.value.dhcpHosts,
    });
    importResults.value = res.data.results;
    toast.add({ severity: 'success', summary: 'Pi-hole import complete', life: 3000 });
    emit('imported');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Import failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { importing.value = false; }
}

function resetState() {
  piholeTab.value = 'online';
  piholeUrl.value = '';
  piholePassword.value = '';
  probeStatus.value = null;
  probeError.value = '';
  needsPassword.value = false;
  preview.value = null;
  importResults.value = null;
  fileContent.value = null;
}

function open() {
  resetState();
  visible.value = true;
}

defineExpose({ open });
</script>

<style scoped>
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.field-error {
  color: #ef4444;
  font-size: 0.75rem;
}
.field-warn {
  color: var(--p-orange-500);
  font-size: 0.75rem;
}
.pihole-import-step {
  min-height: 12rem;
}
.pihole-reachable {
  border-color: var(--p-green-500) !important;
  box-shadow: 0 0 0 1px var(--p-green-500);
}
.pihole-unreachable {
  border-color: var(--p-red-500) !important;
  box-shadow: 0 0 0 1px var(--p-red-500);
}
.pihole-preview {
  margin-top: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  background: var(--p-surface-50);
}
.pihole-preview h4 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.preview-summary {
  display: flex;
  gap: 1.5rem;
}
.preview-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.preview-count {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--p-primary-color);
}
.preview-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.pihole-results {
  margin-top: 1rem;
}
.muted {
  color: var(--p-text-muted-color);
}
</style>
