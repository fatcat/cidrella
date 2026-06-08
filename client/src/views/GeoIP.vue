<template>
  <div class="geoip-page" style="display: flex; flex-direction: column; height: 100%;">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="status">
      <div class="stat">
        <span class="stat-value">
          <span :class="status.running ? 'indicator-on' : 'indicator-off'"></span>
          {{ status.running ? 'Running' : 'Stopped' }}
        </span>
      <span class="stat-label">Proxy Status</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ status.mode === 'allowlist' ? 'Allowlist' : 'Blocklist' }}</span>
        <span class="stat-label">Mode</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ status.ruleCount }}</span>
        <span class="stat-label">Active Rules</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(store.stats.total) }}</span>
        <span class="stat-label">Queries</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(store.stats.blocked) }}</span>
        <span class="stat-label">Blocked</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ status.dbLastUpdated ? formatDate(status.dbLastUpdated) : 'No DB' }}</span>
        <span class="stat-label">GeoIP Database</span>
      </div>
    </div>

    <!-- Settings Row -->
    <div class="settings-row">
      <div class="schedule-group">
        <label class="schedule-label">Enabled:</label>
        <span @click="onEnableClick"><ToggleSwitch v-model="geoipEnabledDisplay" :disabled="noRecursion" /></span>
      </div>
      <div class="schedule-group">
        <label class="schedule-label">Mode:</label>
        <Select v-model="settingsForm.geoip_mode" :options="modeOptions" optionLabel="label"
                optionValue="value" size="small" style="width: 16rem" />
      </div>
      <div class="schedule-group">
        <label class="schedule-label">DB Update:</label>
        <Select v-model="settingsForm.geoip_update_schedule" :options="scheduleOptions"
                optionLabel="label" optionValue="value" size="small" style="width: 10rem" />
      </div>
      <Button label="Save Settings" icon="pi pi-save" size="small" @click="doSaveSettings" :loading="savingSettings" :disabled="!settingsDirty" />
      <Button label="Update DB" icon="pi pi-download" size="small" severity="secondary"
              @click="doRefreshDb" :loading="refreshingDb" />
      <Button label="Add Countries" icon="pi pi-plus" size="small" severity="secondary" @click="openAddCountries" />
    </div>

    <TabView>
      <TabPanel header="Country Rules">
    <!-- Country Rules Table -->
    <DataTable :value="store.rules" :loading="store.loading" stripedRows size="small"
               emptyMessage="No country rules configured."
               :paginator="store.rules.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               scrollable scrollHeight="flex">
      <Column header="" style="width: 3rem">
        <template #body="{ data }">
          <span class="country-flag">{{ countryFlag(data.country_code) }}</span>
        </template>
      </Column>
      <Column field="country_name" header="Country" sortable />
      <Column field="country_code" header="Code" style="width: 5rem" sortable />
      <Column header="Status" style="width: 7rem">
        <template #body="{ data }">
          <span v-if="data.enabled" class="badge badge-green">Active</span>
          <span v-else class="badge badge-muted">Disabled</span>
        </template>
      </Column>
      <Column header="" style="width: 7rem">
        <template #body="{ data }">
          <div class="action-buttons">
            <Button :icon="data.enabled ? 'pi pi-pause' : 'pi pi-play'" severity="secondary"
                    text rounded size="small" @click="doToggleRule(data)"
                    :title="data.enabled ? 'Disable' : 'Enable'" />
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                    @click="confirmDeleteRule(data)" />
          </div>
        </template>
      </Column>
    </DataTable>
      </TabPanel>

      <TabPanel header="Whitelist">
        <p class="wl-hint">A single shared allowlist — domains here are never blocked by GeoIP or category blocking. Editing it here also updates it under Category Blocking.</p>
        <DomainWhitelist :items="store.whitelist" :on-add="addWhitelist" :on-remove="removeWhitelist"
                         add-track="geoip-add-whitelist" />
      </TabPanel>
    </TabView>

    <!-- Add Countries Dialog -->
    <Dialog v-model:visible="showAddDialog" header="Add Countries" modal :style="{ width: '32rem' }">
      <div class="country-search">
        <InputText v-model="countrySearch" placeholder="Search countries..." class="w-full" />
      </div>
      <div class="country-list">
        <label v-for="c in filteredCountries" :key="c.code" class="country-item">
          <input type="checkbox" v-model="selectedCountries" :value="c.code" :disabled="isRuleAdded(c.code)" />
          <span class="country-flag">{{ countryFlag(c.code) }}</span>
          <span>{{ c.name }}</span>
          <span class="country-code">{{ c.code }}</span>
          <span v-if="isRuleAdded(c.code)" class="badge badge-green" style="margin-left: auto;">Added</span>
        </label>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showAddDialog = false" />
        <Button label="Add Selected" @click="doAddCountries" :loading="addingCountries"
                :disabled="selectedCountries.filter(c => !isRuleAdded(c)).length === 0" />
      </template>
    </Dialog>

    <!-- Delete Rule Dialog -->
    <Dialog v-model:visible="showDeleteDialog" header="Delete Rule" modal :style="{ width: '24rem' }">
      <p>Remove <strong>{{ deletingRule?.country_name }}</strong> ({{ deletingRule?.country_code }}) from GeoIP rules?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRule" :loading="deleting" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { formatDateTime } from '../utils/dateFormat.js';
import { formatNumber, apiError } from '../utils/format.js';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import DomainWhitelist from '../components/DomainWhitelist.vue';
import Toast from 'primevue/toast';
import ToggleSwitch from 'primevue/toggleswitch';
import { useGeoipStore } from '../stores/geoip.js';
import { useDnsStore } from '../stores/dns.js';
import { COUNTRIES, countryFlag } from '../utils/countries.js';

const store = useGeoipStore();
const dnsStore = useDnsStore();
const toast = useToast();

const status = ref(null);
const noRecursion = ref(false);

// Settings form
const settingsForm = ref({ geoip_enabled: false, geoip_mode: 'blocklist', geoip_proxy_port: 5353, geoip_update_schedule: 'monthly' });
// Show the toggle OFF (and locked) while recursion is disabled — GeoIP is inert
// then. Non-destructive: the saved preference returns when recursion is on.
const geoipEnabledDisplay = computed({
  get: () => noRecursion.value ? false : settingsForm.value.geoip_enabled,
  set: (v) => { if (!noRecursion.value) settingsForm.value.geoip_enabled = v; },
});
const savedSettings = ref(null);
const savingSettings = ref(false);

const settingsDirty = computed(() => {
  if (!savedSettings.value) return false;
  const s = savedSettings.value;
  const f = settingsForm.value;
  return f.geoip_enabled !== s.geoip_enabled || f.geoip_mode !== s.geoip_mode ||
    f.geoip_proxy_port !== s.geoip_proxy_port || f.geoip_update_schedule !== s.geoip_update_schedule;
});
const refreshingDb = ref(false);

const modeOptions = [
  { label: 'Blocklist — block listed countries', value: 'blocklist' },
  { label: 'Allowlist — allow only listed countries', value: 'allowlist' }
];

const scheduleOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Biweekly', value: 'biweekly' },
  { label: 'Monthly', value: 'monthly' }
];

// Add countries dialog
const showAddDialog = ref(false);
const countrySearch = ref('');
const selectedCountries = ref([]);
const addingCountries = ref(false);

// Delete dialog
const showDeleteDialog = ref(false);
const deletingRule = ref(null);
const deleting = ref(false);

const filteredCountries = computed(() => {
  const q = countrySearch.value.toLowerCase().trim();
  if (!q) return COUNTRIES;
  return COUNTRIES.filter(c =>
    c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
  );
});

function isRuleAdded(code) {
  return store.rules.some(r => r.country_code === code);
}


const formatDate = formatDateTime;

function openAddCountries() {
  countrySearch.value = '';
  selectedCountries.value = [];
  showAddDialog.value = true;
}

async function doAddCountries() {
  const toAdd = selectedCountries.value.filter(c => !isRuleAdded(c));
  if (toAdd.length === 0) return;

  addingCountries.value = true;
  try {
    // Auto-download GeoIP database if not yet present
    if (!status.value?.dbLastUpdated) {
      toast.add({ severity: 'info', summary: 'Downloading GeoIP database...', life: 5000 });
      await store.refreshDb();
      await refreshStatus();
    }

    const countries = toAdd.map(code => {
      const c = COUNTRIES.find(x => x.code === code);
      return { code, name: c?.name || code };
    });
    await store.addRules(countries);
    showAddDialog.value = false;
    toast.add({ severity: 'success', summary: `${toAdd.length} country rule(s) added`, life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    addingCountries.value = false;
  }
}

async function doToggleRule(rule) {
  try {
    await store.toggleRule(rule.id, !rule.enabled);
    toast.add({ severity: 'success', summary: `${rule.country_name} ${rule.enabled ? 'disabled' : 'enabled'}`, life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

function confirmDeleteRule(rule) {
  deletingRule.value = rule;
  showDeleteDialog.value = true;
}

async function doDeleteRule() {
  deleting.value = true;
  try {
    await store.deleteRule(deletingRule.value.id);
    showDeleteDialog.value = false;
    toast.add({ severity: 'success', summary: 'Rule deleted', life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    deleting.value = false;
  }
}

async function doSaveSettings() {
  savingSettings.value = true;
  try {
    await store.updateSettings(settingsForm.value);
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

async function doRefreshDb() {
  refreshingDb.value = true;
  try {
    await store.refreshDb();
    toast.add({ severity: 'success', summary: 'GeoIP database updated', life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Download failed', detail: apiError(err), life: 5000 });
  } finally {
    refreshingDb.value = false;
  }
}

// Whitelist handlers passed to the shared DomainWhitelist component.
async function addWhitelist(domain, reason) {
  try {
    await store.addWhitelist(domain, reason);
    toast.add({ severity: 'success', summary: 'Domain whitelisted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
    throw err;
  }
}

async function removeWhitelist(item) {
  try {
    await store.removeWhitelist(item.id);
    toast.add({ severity: 'success', summary: 'Removed from whitelist', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

// GeoIP filtering only applies to forwarded/recursive queries. When recursion is
// disabled the enable toggle is locked; explain why on a click attempt.
function onEnableClick() {
  if (noRecursion.value) {
    toast.add({
      severity: 'warn',
      summary: 'Recursion is disabled',
      detail: 'GeoIP filtering only applies to recursive queries. Enable recursion in Settings → DNS → Upstream Forwarders first.',
      life: 5000,
    });
  }
}

async function refreshStatus() {
  const s = await store.fetchStatus();
  status.value = s;
  const vals = {
    geoip_enabled: s.enabled,
    geoip_mode: s.mode,
    geoip_proxy_port: s.port,
    geoip_update_schedule: s.updateSchedule || 'monthly'
  };
  settingsForm.value = { ...vals };
  savedSettings.value = { ...vals };
}

onMounted(async () => {
  await Promise.all([
    store.fetchRules(),
    store.fetchStats(),
    store.fetchWhitelist(),
    refreshStatus()
  ]);
  try { noRecursion.value = !!(await dnsStore.getForwarders()).no_recursion; } catch { /* ignore */ }
});
</script>

<style>
@import '../assets/analytics-layout.css';
</style>

<style scoped>
.geoip-page h2 {
  margin: 0 0 1rem 0;
}
.country-flag { font-size: 1.1rem; }
.wl-hint { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); margin: 0 0 0.75rem; line-height: 1.4; }
.action-buttons { display: flex; gap: 0.25rem; }
.country-search { margin-bottom: 0.75rem; }
.country-list {
  max-height: 350px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.country-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.9rem;
}
.country-item:hover { background: var(--p-surface-hover); }
.country-code { font-size: 0.75rem; color: var(--p-text-muted-color); font-family: monospace; }
</style>
