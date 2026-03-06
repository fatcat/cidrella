<template>
  <div class="blocklists-page">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="stats.total_sources > 0">
      <div class="stat">
        <span class="stat-value">{{ stats.enabled_sources }}</span>
        <span class="stat-label">Active Sources</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(stats.total_domains) }}</span>
        <span class="stat-label">Blocked Domains</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ stats.whitelist_count }}</span>
        <span class="stat-label">Whitelisted</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ stats.last_update ? formatDate(stats.last_update) : 'Never' }}</span>
        <span class="stat-label">Last Updated</span>
      </div>
    </div>

    <TabView>
      <!-- Sources Tab -->
      <TabPanel header="Sources">
        <!-- Category Toggles -->
        <div class="category-bar" v-if="categories.length > 0">
          <div v-for="cat in categories" :key="cat.category" class="category-toggle"
               :class="{ 'category-disabled': cat.enabled_count === 0 }">
            <label class="category-label">
              <input type="checkbox" :checked="cat.enabled_count > 0"
                     @change="toggleCategoryEnabled(cat.category, $event.target.checked)"
                     :disabled="togglingCategory === cat.category" />
              <span class="category-dot" :style="{ background: categoryColors[cat.category] }"></span>
              <span class="category-name">{{ categoryLabels[cat.category] || cat.category }}</span>
              <span class="category-count">{{ cat.source_count }} source{{ cat.source_count !== 1 ? 's' : '' }}</span>
            </label>
          </div>
        </div>
        <div class="section-header">
          <Button label="Add Source" icon="pi pi-plus" size="small" @click="openAddSource" />
          <Button label="Popular Lists" icon="pi pi-star" size="small" severity="secondary" @click="showPopularDialog = true" />
          <Button label="Refresh All" icon="pi pi-refresh" size="small" severity="secondary"
                  @click="doRefreshAll" :loading="refreshingAll" />
        </div>
        <DataTable :value="store.sources" :loading="store.loading" stripedRows size="small"
                   emptyMessage="No blocklist sources configured.">
          <Column field="name" header="Name" sortable />
          <Column header="Category" style="width: 7rem">
            <template #body="{ data }">
              <span class="category-badge" :style="{ background: categoryColors[data.category] + '20', color: categoryColors[data.category], borderColor: categoryColors[data.category] + '40' }">
                {{ categoryLabels[data.category] || data.category }}
              </span>
            </template>
          </Column>
          <Column field="url" header="URL">
            <template #body="{ data }">
              <span class="url-text" :title="data.url">{{ truncateUrl(data.url) }}</span>
            </template>
          </Column>
          <Column header="Entries" style="width: 6rem">
            <template #body="{ data }">{{ formatNumber(data.entry_count || data.last_entry_count) }}</template>
          </Column>
          <Column header="Last Updated" style="width: 10rem">
            <template #body="{ data }">
              {{ data.last_fetched_at ? formatDate(data.last_fetched_at) : 'Never' }}
            </template>
          </Column>
          <Column header="Status" style="width: 6rem">
            <template #body="{ data }">
              <span v-if="data.last_error" class="badge-error" :title="data.last_error">Error</span>
              <span v-else-if="data.enabled" class="badge-active">Active</span>
              <span v-else class="badge-disabled">Disabled</span>
            </template>
          </Column>
          <Column header="" style="width: 7rem">
            <template #body="{ data }">
              <div class="action-buttons">
                <Button icon="pi pi-refresh" severity="secondary" text rounded size="small"
                        @click="doRefreshSource(data)" :loading="refreshingId === data.id" />
                <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                        @click="editSource(data)" />
                <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                        @click="confirmDeleteSource(data)" />
              </div>
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
        <DataTable :value="store.whitelist" stripedRows size="small" emptyMessage="No whitelisted domains.">
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
                   stripedRows size="small" emptyMessage="No matching domains found.">
          <Column field="domain" header="Domain" />
          <Column field="sources" header="Sources" />
          <Column header="Status" style="width: 8rem">
            <template #body="{ data }">
              <span v-if="data.whitelisted" class="badge-whitelisted">Whitelisted</span>
              <span v-else class="badge-blocked">Blocked</span>
            </template>
          </Column>
        </DataTable>
        <div class="search-pagination" v-if="searchResults.total > searchLimit">
          <Button label="Previous" severity="secondary" size="small" :disabled="searchPage <= 1"
                  @click="searchPage--; doSearch()" />
          <span class="page-info">Page {{ searchPage }} of {{ Math.ceil(searchResults.total / searchLimit) }}</span>
          <Button label="Next" severity="secondary" size="small"
                  :disabled="searchPage >= Math.ceil(searchResults.total / searchLimit)"
                  @click="searchPage++; doSearch()" />
        </div>
      </TabPanel>
    </TabView>

    <!-- Add/Edit Source Dialog -->
    <Dialog v-model:visible="showSourceDialog" :header="editingSource ? 'Edit Source' : 'Add Source'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Name *</label>
          <InputText v-model="sourceForm.name" class="w-full" />
        </div>
        <div class="field">
          <label>URL *</label>
          <InputText v-model="sourceForm.url" class="w-full" placeholder="https://..." />
        </div>
        <div class="field">
          <label>Category</label>
          <Select v-model="sourceForm.category" :options="categoryOptions" optionLabel="label" optionValue="value"
                  class="w-full" />
        </div>
        <div class="field">
          <label>Format</label>
          <Select v-model="sourceForm.format" :options="formatOptions" optionLabel="label" optionValue="value"
                  class="w-full" />
        </div>
        <div class="field">
          <label>Update Interval (hours)</label>
          <InputText v-model.number="sourceForm.update_interval_hours" type="number" class="w-full" />
        </div>
        <div class="field checkbox-field">
          <label>
            <input type="checkbox" v-model="sourceForm.enabled" /> Enabled
          </label>
          <label>
            <input type="checkbox" v-model="sourceForm.auto_update" /> Auto-update
          </label>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="closeSourceDialog" />
        <Button :label="editingSource ? 'Save' : 'Add'" @click="saveSource" :loading="savingSource" />
      </template>
    </Dialog>

    <!-- Delete Source Dialog -->
    <Dialog v-model:visible="showDeleteDialog" header="Delete Source" modal :style="{ width: '24rem' }">
      <p>Delete <strong>{{ deletingSource?.name }}</strong> and all its entries?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteSource" :loading="savingSource" />
      </template>
    </Dialog>

    <!-- Popular Lists Dialog -->
    <Dialog v-model:visible="showPopularDialog" header="Popular Blocklists" modal :style="{ width: '32rem' }">
      <p style="margin-top: 0;">Select lists to add:</p>
      <div class="popular-list" v-for="list in popularLists" :key="list.url">
        <label class="popular-item">
          <input type="checkbox" v-model="list.selected" :disabled="isSourceAdded(list.url)" />
          <div>
            <strong>{{ list.name }}</strong>
            <span v-if="isSourceAdded(list.url)" class="badge-active" style="margin-left: 0.5rem;">Added</span>
            <div class="popular-desc">{{ list.description }}</div>
          </div>
        </label>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showPopularDialog = false" />
        <Button label="Add Selected" @click="addPopularLists" :loading="addingPopular"
                :disabled="popularLists.filter(l => l.selected && !isSourceAdded(l.url)).length === 0" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
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
import { useBlocklistStore } from '../stores/blocklists.js';

const store = useBlocklistStore();
const toast = useToast();

const stats = ref({ total_sources: 0, enabled_sources: 0, total_domains: 0, whitelist_count: 0, last_update: null });

// Source CRUD
const showSourceDialog = ref(false);
const showDeleteDialog = ref(false);
const editingSource = ref(null);
const deletingSource = ref(null);
const savingSource = ref(false);
const refreshingId = ref(null);
const refreshingAll = ref(false);
const sourceForm = ref({ name: '', url: '', format: 'auto', category: 'other', update_interval_hours: 24, enabled: true, auto_update: true });

const formatOptions = [
  { label: 'Auto-detect', value: 'auto' },
  { label: 'Hosts file', value: 'hosts' },
  { label: 'Domain list', value: 'domains' },
  { label: 'Adblock filter', value: 'adblock' }
];

const categoryOptions = [
  { label: 'Ads', value: 'ads' },
  { label: 'Malware', value: 'malware' },
  { label: 'Tracking', value: 'tracking' },
  { label: 'Adult', value: 'adult' },
  { label: 'Other', value: 'other' }
];

const categoryLabels = { ads: 'Ads', malware: 'Malware', tracking: 'Tracking', adult: 'Adult', other: 'Other' };
const categoryColors = { ads: '#3b82f6', malware: '#ef4444', tracking: '#f59e0b', adult: '#8b5cf6', other: '#6b7280' };

// Categories
const categories = ref([]);
const togglingCategory = ref(null);

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

// Popular lists
const showPopularDialog = ref(false);
const addingPopular = ref(false);
const popularLists = ref([
  { name: 'Steven Black Unified', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', description: 'Adware + malware hosts (~170K domains)', category: 'malware', selected: false },
  { name: 'OISD Small', url: 'https://small.oisd.nl/', description: 'Balanced ad-blocking list for most users', category: 'ads', selected: false },
  { name: "Pete Lowe's Ad Servers", url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0', description: 'Minimal, well-maintained ad server list', category: 'ads', selected: false },
  { name: 'AdGuard DNS Filter', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', description: 'AdGuard DNS-level ad blocking filter', category: 'ads', selected: false }
]);

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '...' : u.pathname;
    return u.hostname + p;
  } catch { return url; }
}

function isSourceAdded(url) {
  return store.sources.some(s => s.url === url);
}

function openAddSource() {
  editingSource.value = null;
  sourceForm.value = { name: '', url: '', format: 'auto', category: 'other', update_interval_hours: 24, enabled: true, auto_update: true };
  showSourceDialog.value = true;
}

function editSource(source) {
  editingSource.value = source;
  sourceForm.value = {
    name: source.name, url: source.url, format: source.format,
    category: source.category || 'other',
    update_interval_hours: source.update_interval_hours,
    enabled: !!source.enabled, auto_update: !!source.auto_update
  };
  showSourceDialog.value = true;
}

function closeSourceDialog() {
  showSourceDialog.value = false;
  editingSource.value = null;
}

async function saveSource() {
  savingSource.value = true;
  try {
    if (editingSource.value) {
      await store.updateSource(editingSource.value.id, sourceForm.value);
      toast.add({ severity: 'success', summary: 'Source updated', life: 3000 });
    } else {
      await store.createSource(sourceForm.value);
      toast.add({ severity: 'success', summary: 'Source added', life: 3000 });
    }
    closeSourceDialog();
    await Promise.all([
      store.fetchStats().then(s => stats.value = s),
      store.fetchCategories().then(c => categories.value = c)
    ]);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSource.value = false;
  }
}

function confirmDeleteSource(source) {
  deletingSource.value = source;
  showDeleteDialog.value = true;
}

async function doDeleteSource() {
  savingSource.value = true;
  try {
    await store.deleteSource(deletingSource.value.id);
    showDeleteDialog.value = false;
    toast.add({ severity: 'success', summary: 'Source deleted', life: 3000 });
    await Promise.all([
      store.fetchStats().then(s => stats.value = s),
      store.fetchCategories().then(c => categories.value = c)
    ]);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSource.value = false;
  }
}

async function doRefreshSource(source) {
  refreshingId.value = source.id;
  try {
    await store.refreshSource(source.id);
    toast.add({ severity: 'success', summary: `${source.name} refreshed`, life: 3000 });
    await store.fetchStats().then(s => stats.value = s);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    refreshingId.value = null;
  }
}

async function doRefreshAll() {
  refreshingAll.value = true;
  try {
    await store.refreshAll();
    toast.add({ severity: 'success', summary: 'All sources refreshed', life: 3000 });
    await store.fetchStats().then(s => stats.value = s);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    refreshingAll.value = false;
  }
}

async function addPopularLists() {
  addingPopular.value = true;
  try {
    for (const list of popularLists.value) {
      if (list.selected && !isSourceAdded(list.url)) {
        await store.createSource({ name: list.name, url: list.url, format: 'auto', category: list.category });
      }
    }
    showPopularDialog.value = false;
    popularLists.value.forEach(l => l.selected = false);
    toast.add({ severity: 'success', summary: 'Lists added', life: 3000 });
    await Promise.all([
      store.fetchStats().then(s => stats.value = s),
      store.fetchCategories().then(c => categories.value = c)
    ]);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    addingPopular.value = false;
  }
}

// Category toggle
async function toggleCategoryEnabled(category, enabled) {
  togglingCategory.value = category;
  try {
    await store.toggleCategory(category, enabled);
    categories.value = await store.fetchCategories();
    await store.fetchStats().then(s => stats.value = s);
    toast.add({ severity: 'success', summary: `${categoryLabels[category]} ${enabled ? 'enabled' : 'disabled'}`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    togglingCategory.value = null;
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
async function doSearch() {
  if (!searchQuery.value.trim() || searchQuery.value.trim().length < 2) return;
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
  await Promise.all([
    store.fetchSources(),
    store.fetchWhitelist(),
    store.fetchStats().then(s => stats.value = s),
    store.fetchCategories().then(c => categories.value = c)
  ]);
});
</script>

<style scoped>
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
.section-header {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.url-text {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.format-badge {
  font-size: 0.75rem;
  background: var(--p-surface-200);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.badge-active { font-size: 0.75rem; background: #dcfce7; color: #166534; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; }
.badge-disabled { font-size: 0.75rem; background: var(--p-surface-200); color: var(--p-text-muted-color); padding: 0.15rem 0.5rem; border-radius: 4px; }
.badge-error { font-size: 0.75rem; background: #fee2e2; color: #991b1b; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; cursor: help; }
.badge-blocked { font-size: 0.75rem; background: #fee2e2; color: #991b1b; padding: 0.15rem 0.5rem; border-radius: 4px; }
.badge-whitelisted { font-size: 0.75rem; background: #dcfce7; color: #166534; padding: 0.15rem 0.5rem; border-radius: 4px; }
.action-buttons { display: flex; gap: 0.25rem; }
.form-grid { display: flex; flex-direction: column; gap: 1rem; }
.field label { display: block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600; }
.checkbox-field { display: flex; gap: 1.5rem; }
.checkbox-field label { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-weight: normal; }
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
.category-bar {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  margin-bottom: 0.75rem;
}
.category-toggle { }
.category-toggle.category-disabled { opacity: 0.5; }
.category-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.category-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.category-name { font-weight: 600; }
.category-count { font-size: 0.75rem; color: var(--p-text-muted-color); }
.category-badge {
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  border: 1px solid;
}
.popular-list { margin-bottom: 0.75rem; }
.popular-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  cursor: pointer;
}
.popular-item input { margin-top: 0.3rem; }
.popular-desc { font-size: 0.8rem; color: var(--p-text-muted-color); }
</style>
