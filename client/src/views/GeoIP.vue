<template>
  <div class="geoip-page">
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

    <TabView>
      <!-- Country Rules Tab -->
      <TabPanel header="Country Rules">
        <div class="section-header">
          <Button label="Add Countries" icon="pi pi-plus" size="small" @click="openAddCountries" />
        </div>
        <DataTable :value="store.rules" :loading="store.loading" stripedRows size="small"
                   emptyMessage="No country rules configured.">
          <Column header="" style="width: 3rem">
            <template #body="{ data }">
              <span class="country-flag">{{ countryFlag(data.country_code) }}</span>
            </template>
          </Column>
          <Column field="country_name" header="Country" sortable />
          <Column field="country_code" header="Code" style="width: 5rem" sortable />
          <Column header="Status" style="width: 7rem">
            <template #body="{ data }">
              <span v-if="data.enabled" class="badge-active">Active</span>
              <span v-else class="badge-disabled">Disabled</span>
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

      <!-- Settings Tab -->
      <TabPanel header="Settings">
        <div class="settings-form">
          <div class="setting-group">
            <h3>GeoIP Proxy</h3>
            <div class="field checkbox-field">
              <label>
                <input type="checkbox" v-model="settingsForm.geoip_enabled" />
                Enable GeoIP DNS filtering
              </label>
            </div>
            <div class="field">
              <label>Filtering Mode</label>
              <Select v-model="settingsForm.geoip_mode" :options="modeOptions" optionLabel="label"
                      optionValue="value" class="w-full" />
              <small class="hint" v-if="settingsForm.geoip_mode === 'blocklist'">
                DNS queries resolving to IPs in listed countries will be blocked.
              </small>
              <small class="hint" v-else>
                Only DNS queries resolving to IPs in listed countries will be allowed. All others blocked.
              </small>
            </div>
            <div class="field">
              <label>Proxy Port</label>
              <InputText v-model.number="settingsForm.geoip_proxy_port" type="number" class="w-full"
                         :min="1024" :max="65535" />
            </div>
            <Button label="Save Settings" icon="pi pi-check" @click="doSaveSettings" :loading="savingSettings" />
          </div>

          <div class="setting-group">
            <h3>GeoIP Database</h3>
            <div class="db-info" v-if="status">
              <div><strong>Status:</strong> {{ status.dbLoaded ? 'Loaded' : (status.dbExists ? 'Not loaded' : 'Not downloaded') }}</div>
              <div><strong>Last Updated:</strong> {{ status.dbLastUpdated ? formatDate(status.dbLastUpdated) : 'Never' }}</div>
            </div>
            <Button label="Download / Update Database" icon="pi pi-download" severity="secondary"
                    @click="doRefreshDb" :loading="refreshingDb" />
            <small class="hint">Downloads the latest DB-IP Lite country database. Auto-updates monthly when enabled.</small>
          </div>
        </div>
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
          <span v-if="isRuleAdded(c.code)" class="badge-active" style="margin-left: auto;">Added</span>
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
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Toast from 'primevue/toast';
import { useGeoipStore } from '../stores/geoip.js';
import { COUNTRIES, countryFlag } from '../utils/countries.js';

const store = useGeoipStore();
const toast = useToast();

const status = ref(null);

// Settings form
const settingsForm = ref({ geoip_enabled: false, geoip_mode: 'blocklist', geoip_proxy_port: 5353 });
const savingSettings = ref(false);
const refreshingDb = ref(false);

const modeOptions = [
  { label: 'Blocklist — block listed countries', value: 'blocklist' },
  { label: 'Allowlist — allow only listed countries', value: 'allowlist' }
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

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
    const countries = toAdd.map(code => {
      const c = COUNTRIES.find(x => x.code === code);
      return { code, name: c?.name || code };
    });
    await store.addRules(countries);
    showAddDialog.value = false;
    toast.add({ severity: 'success', summary: `${toAdd.length} country rule(s) added`, life: 3000 });
    await refreshStatus();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Download failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    refreshingDb.value = false;
  }
}

async function refreshStatus() {
  const s = await store.fetchStatus();
  status.value = s;
  settingsForm.value = {
    geoip_enabled: s.enabled,
    geoip_mode: s.mode,
    geoip_proxy_port: s.port
  };
}

onMounted(async () => {
  await Promise.all([
    store.fetchRules(),
    store.fetchStats(),
    refreshStatus()
  ]);
});
</script>

<style scoped>
.geoip-page h2 {
  margin: 0 0 1rem 0;
}
.stats-bar {
  display: flex;
  gap: 2rem;
  padding: 1rem 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.25rem; font-weight: 700; font-family: monospace; display: flex; align-items: center; gap: 0.4rem; }
.stat-label { font-size: 0.75rem; color: var(--p-text-muted-color); text-transform: uppercase; }
.indicator-on { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; }
.indicator-off { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; display: inline-block; }
.section-header {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.country-flag { font-size: 1.1rem; }
.badge-active { font-size: 0.75rem; background: #dcfce7; color: #166534; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; }
.badge-disabled { font-size: 0.75rem; background: var(--p-surface-200); color: var(--p-text-muted-color); padding: 0.15rem 0.5rem; border-radius: 4px; }
.action-buttons { display: flex; gap: 0.25rem; }
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 500px;
}
.setting-group h3 { margin: 0 0 1rem 0; }
.field { margin-bottom: 1rem; }
.field label { display: block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600; }
.checkbox-field label { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-weight: normal; }
.hint { display: block; margin-top: 0.35rem; font-size: 0.8rem; color: var(--p-text-muted-color); }
.db-info {
  font-size: 0.9rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
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
