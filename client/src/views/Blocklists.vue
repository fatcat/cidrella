<template>
  <div class="blocklists-page" style="display: flex; flex-direction: column; height: 100%;">
    <!-- Stats Bar -->
    <div class="stats-bar">
      <div class="stat">
        <span class="stat-value">{{ stats.enabled_categories || 0 }}</span>
        <span class="stat-label">Enabled Categories</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(stats.total_domains) }}</span>
        <span class="stat-label">Blocked Domains</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ stats.whitelist_count || 0 }}</span>
        <span class="stat-label">Whitelisted</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ stats.last_update ? formatDate(stats.last_update) : 'Never' }}</span>
        <span class="stat-label">Last Updated</span>
      </div>
    </div>

    <TabView>
      <!-- Categories Tab -->
      <TabPanel header="Categories">
        <!-- Settings Row -->
        <div class="settings-row">
          <div class="schedule-group">
            <label class="schedule-label">Update Schedule:</label>
            <Select v-model="settings.blocklist_update_schedule" :options="scheduleOptions"
                    optionLabel="label" optionValue="value" size="small" style="width: 10rem" />
          </div>
          <Button label="Save Settings" icon="pi pi-save" size="small" @click="doSaveSettings" :loading="savingSettings" />
          <Button label="Refresh All" icon="pi pi-refresh" size="small" severity="secondary"
                  @click="doRefreshAll" :loading="refreshingAll" />
        </div>

        <!-- Category Table -->
        <DataTable :value="store.categories" :loading="store.loading" stripedRows size="small"
                   emptyMessage="Loading categories..." dataKey="slug"
                   :paginator="store.categories.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column style="width: 3.5rem">
            <template #header>
              <input type="checkbox" :checked="allEnabled" :indeterminate="someEnabled && !allEnabled"
                     @change="doToggleAll($event.target.checked)" :disabled="togglingAll" />
            </template>
            <template #body="{ data }">
              <input type="checkbox" :checked="data.enabled"
                     @change="doToggleCategory(data, $event.target.checked)"
                     :disabled="togglingSlug === data.slug || togglingAll" />
            </template>
          </Column>
          <Column header="Category" style="min-width: 14rem">
            <template #body="{ data }">
              <div>
                <strong>{{ data.name }}</strong>
                <div class="text-sm muted">{{ data.description }}</div>
              </div>
            </template>
          </Column>
          <Column header="Group" style="width: 5rem">
            <template #body="{ data }">
              <span :class="data.group === 'beta' ? 'badge-beta' : 'badge-main'">
                {{ data.group === 'beta' ? 'Beta' : 'Main' }}
              </span>
            </template>
          </Column>
          <Column header="Domains" style="width: 7rem">
            <template #body="{ data }">
              {{ data.domain_count > 0 ? formatNumber(data.domain_count) : '—' }}
            </template>
          </Column>
          <Column header="Last Updated" style="width: 10rem">
            <template #body="{ data }">
              {{ data.last_fetched_at ? formatDate(data.last_fetched_at) : 'Never' }}
            </template>
          </Column>
          <Column header="Status" style="width: 6rem">
            <template #body="{ data }">
              <span v-if="data.last_error" class="badge-error" :title="data.last_error">Error</span>
              <span v-else-if="data.enabled && data.last_fetched_at" class="badge-active">Active</span>
              <span v-else-if="data.enabled" class="badge-pending">Pending</span>
              <span v-else class="badge-disabled">Off</span>
            </template>
          </Column>
          <Column header="Source URL" style="min-width: 18rem">
            <template #body="{ data }">
              <div class="url-cell">
                <template v-if="editingUrlSlug === data.slug">
                  <InputText v-model="editingUrlValue" class="url-input" size="small" placeholder="https://..."
                             @keyup.enter="doSaveUrl(data.slug)" @keyup.escape="editingUrlSlug = null" />
                  <Button icon="pi pi-check" severity="success" text rounded size="small" @click="doSaveUrl(data.slug)" :loading="savingUrl" />
                  <Button icon="pi pi-times" severity="secondary" text rounded size="small" @click="editingUrlSlug = null" />
                </template>
                <template v-else>
                  <span class="url-text" :class="{ 'url-custom': data.is_custom_url }" :title="data.source_url">{{ data.source_url }}</span>
                  <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                          @click="startEditUrl(data)" title="Edit URL" />
                  <Button v-if="data.is_custom_url" icon="pi pi-undo" severity="secondary" text rounded size="small"
                          @click="doResetUrl(data.slug)" title="Reset to default URL" :loading="savingUrl" />
                </template>
              </div>
            </template>
          </Column>
          <Column header="" style="width: 3.5rem">
            <template #body="{ data }">
              <Button v-if="data.enabled" icon="pi pi-refresh" severity="secondary" text rounded size="small"
                      @click="doRefreshCategory(data)" :loading="refreshingSlug === data.slug"
                      title="Refresh this category" />
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <!-- Whitelist Tab -->
      <TabPanel header="Whitelist">
        <div class="whitelist-add">
          <InputText v-model="newWhitelistDomain" placeholder="domain.com" class="wl-input" />
          <InputText v-model="newWhitelistReason" placeholder="Reason (optional)" class="wl-reason" />
          <Button label="Add" icon="pi pi-plus" size="small" @click="doAddWhitelist" :loading="addingWhitelist" />
        </div>
        <DataTable :value="store.whitelist" stripedRows size="small" emptyMessage="No whitelisted domains."
                   :paginator="store.whitelist.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column field="domain" header="Domain" sortable />
          <Column field="reason" header="Reason">
            <template #body="{ data }">{{ data.reason || '—' }}</template>
          </Column>
          <Column field="created_at" header="Added" style="width: 10rem">
            <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
          </Column>
          <Column header="" style="width: 4rem">
            <template #body="{ data }">
              <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                      @click="doRemoveWhitelist(data)" />
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <!-- Search Tab -->
      <TabPanel header="Search">
        <div class="search-bar">
          <InputText v-model="searchQuery" placeholder="Search blocked domains..." class="search-input"
                     @keyup.enter="doSearch" />
          <Button label="Search" icon="pi pi-search" size="small" @click="doSearch" :loading="searching" />
        </div>
        <DataTable v-if="searchResults.items.length > 0 || searchPerformed" :value="searchResults.items"
                   stripedRows size="small" emptyMessage="No matching domains found."
                   :paginator="searchResults.items.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column field="domain" header="Domain" />
          <Column field="categories" header="Categories" />
          <Column header="Status" style="width: 8rem">
            <template #body="{ data }">
              <span v-if="data.whitelisted" class="badge-whitelisted">Whitelisted</span>
              <span v-else class="badge-blocked">Blocked</span>
            </template>
          </Column>
        </DataTable>
        <div class="search-pagination" v-if="searchResults.total > searchLimit">
          <Button label="Previous" severity="secondary" size="small" :disabled="searchPage <= 1"
                  @click="searchPage--; doSearch(true)" />
          <span class="page-info">Page {{ searchPage }} of {{ Math.ceil(searchResults.total / searchLimit) }}</span>
          <Button label="Next" severity="secondary" size="small"
                  :disabled="searchPage >= Math.ceil(searchResults.total / searchLimit)"
                  @click="searchPage++; doSearch(true)" />
        </div>
      </TabPanel>
    </TabView>

    <Toast />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Toast from 'primevue/toast';
import { useBlocklistStore } from '../stores/blocklists.js';

const store = useBlocklistStore();
const toast = useToast();

const stats = ref({ enabled_categories: 0, total_domains: 0, whitelist_count: 0, last_update: null });
const settings = reactive({ blocklist_enabled: 'true', blocklist_redirect_ip: '', blocklist_update_schedule: 'daily' });

const scheduleOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Every 6 hours', value: '6h' },
  { label: 'Every 12 hours', value: '12h' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' }
];

// Category toggling
const togglingSlug = ref(null);
const togglingAll = ref(false);

const allEnabled = computed(() => store.categories.length > 0 && store.categories.every(c => c.enabled));
const someEnabled = computed(() => store.categories.some(c => c.enabled));
const refreshingSlug = ref(null);
const refreshingAll = ref(false);
const savingSettings = ref(false);

// URL editing
const editingUrlSlug = ref(null);
const editingUrlValue = ref('');
const savingUrl = ref(false);

function startEditUrl(cat) {
  editingUrlSlug.value = cat.slug;
  editingUrlValue.value = cat.source_url;
}

async function doSaveUrl(slug) {
  savingUrl.value = true;
  try {
    await store.updateCategoryUrl(slug, editingUrlValue.value.trim());
    editingUrlSlug.value = null;
    toast.add({ severity: 'success', summary: 'URL updated', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingUrl.value = false;
  }
}

async function doResetUrl(slug) {
  savingUrl.value = true;
  try {
    await store.updateCategoryUrl(slug, '');
    toast.add({ severity: 'success', summary: 'URL reset to default', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingUrl.value = false;
  }
}

// Whitelist
const newWhitelistDomain = ref('');
const newWhitelistReason = ref('');
const addingWhitelist = ref(false);

// Search
const searchQuery = ref('');
const searchResults = ref({ items: [], total: 0 });
const searchPage = ref(1);
const searchLimit = 50;
const searching = ref(false);
const searchPerformed = ref(false);

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function doToggleCategory(cat, enabled) {
  togglingSlug.value = cat.slug;
  try {
    await store.toggleCategory(cat.slug, enabled);
    await store.fetchStats().then(s => stats.value = s);
    toast.add({ severity: 'success', summary: `${cat.name} ${enabled ? 'enabled' : 'disabled'}`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    togglingSlug.value = null;
  }
}

async function doToggleAll(enabled) {
  togglingAll.value = true;
  try {
    const toToggle = store.categories.filter(c => c.enabled !== enabled);
    for (const cat of toToggle) {
      await store.toggleCategory(cat.slug, enabled);
    }
    toast.add({ severity: 'success', summary: `All categories ${enabled ? 'enabled' : 'disabled'}`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    togglingAll.value = false;
    await store.fetchStats().then(s => stats.value = s).catch(() => {});
  }
}

async function doRefreshCategory(cat) {
  refreshingSlug.value = cat.slug;
  try {
    await store.refreshCategory(cat.slug);
    await store.fetchStats().then(s => stats.value = s);
    toast.add({ severity: 'success', summary: `${cat.name} refreshed`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    refreshingSlug.value = null;
  }
}

async function doRefreshAll() {
  refreshingAll.value = true;
  try {
    await store.refreshAll();
    await store.fetchStats().then(s => stats.value = s);
    toast.add({ severity: 'success', summary: 'All categories refreshed', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    refreshingAll.value = false;
  }
}

async function doSaveSettings() {
  savingSettings.value = true;
  try {
    await store.updateSettings({
      blocklist_enabled: 'true',
      blocklist_redirect_ip: settings.blocklist_redirect_ip,
      blocklist_update_schedule: settings.blocklist_update_schedule
    });
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

// Whitelist
async function doAddWhitelist() {
  if (!newWhitelistDomain.value.trim()) return;
  addingWhitelist.value = true;
  try {
    await store.addWhitelist(newWhitelistDomain.value.trim(), newWhitelistReason.value.trim() || undefined);
    newWhitelistDomain.value = '';
    newWhitelistReason.value = '';
    toast.add({ severity: 'success', summary: 'Domain whitelisted', life: 3000 });
    await store.fetchStats().then(s => stats.value = s);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    addingWhitelist.value = false;
  }
}

async function doRemoveWhitelist(entry) {
  try {
    await store.removeWhitelist(entry.id);
    toast.add({ severity: 'success', summary: 'Removed from whitelist', life: 3000 });
    await store.fetchStats().then(s => stats.value = s);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

// Search
async function doSearch(fromPagination = false) {
  if (!searchQuery.value.trim() || searchQuery.value.trim().length < 2) return;
  if (!fromPagination) searchPage.value = 1;
  searching.value = true;
  searchPerformed.value = true;
  try {
    searchResults.value = await store.searchDomains(searchQuery.value.trim(), searchPage.value, searchLimit);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Search failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    searching.value = false;
  }
}

onMounted(async () => {
  const [, , fetchedSettings] = await Promise.all([
    store.fetchCategories(),
    store.fetchWhitelist(),
    store.fetchSettings(),
    store.fetchStats().then(s => stats.value = s)
  ]);
  Object.assign(settings, fetchedSettings);
});
</script>

<style scoped>
.blocklists-page { padding: 1.5rem 2rem; box-sizing: border-box; }
.blocklists-page :deep(.p-tabview) { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.blocklists-page :deep(.p-tabview-panels) { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.blocklists-page :deep(.p-tabview-panel) { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.blocklists-page h2 {
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
}
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.25rem; font-weight: 700; font-family: monospace; }
.stat-label { font-size: 0.75rem; color: var(--p-text-muted-color); text-transform: uppercase; }

.settings-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.schedule-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.schedule-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.text-sm { font-size: 0.8rem; }
.muted { color: var(--p-text-muted-color); }

.badge-main { font-size: 0.7rem; background: var(--p-surface-ground); color: var(--p-text-muted-color); padding: 0.1rem 0.4rem; border-radius: 4px; }
.badge-beta { font-size: 0.7rem; background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); padding: 0.1rem 0.4rem; border-radius: 4px; }
.badge-active { font-size: 0.75rem; background: color-mix(in srgb, var(--p-green-500) 20%, transparent); color: var(--p-green-500); padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; }
.badge-pending { font-size: 0.75rem; background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); padding: 0.15rem 0.5rem; border-radius: 4px; }
.badge-disabled { font-size: 0.75rem; background: var(--p-surface-ground); color: var(--p-text-muted-color); padding: 0.15rem 0.5rem; border-radius: 4px; }
.badge-error { font-size: 0.75rem; background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; cursor: help; }
.badge-blocked { font-size: 0.75rem; background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); padding: 0.15rem 0.5rem; border-radius: 4px; }
.badge-whitelisted { font-size: 0.75rem; background: color-mix(in srgb, var(--p-green-500) 20%, transparent); color: var(--p-green-500); padding: 0.15rem 0.5rem; border-radius: 4px; }

.whitelist-add {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  align-items: center;
}
.wl-input { width: 16rem; }
.wl-reason { width: 14rem; }

.search-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.search-input { width: 20rem; }
.search-pagination {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
}
.page-info { font-size: 0.85rem; color: var(--p-text-muted-color); }

.url-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
.url-text {
  font-size: 0.75rem;
  font-family: monospace;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.url-custom {
  color: var(--p-primary-color);
  font-weight: 600;
}
.url-input {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  font-family: monospace;
}
</style>
