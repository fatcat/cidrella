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

    <!-- Settings Row -->
    <div class="settings-row">
      <div class="schedule-group">
        <label class="schedule-label">Enabled:</label>
        <span @click="onEnableClick"><ToggleSwitch v-model="blocklistEnabledDisplay" :disabled="noRecursion" /></span>
      </div>
      <div class="schedule-group">
        <label class="schedule-label">Update Schedule:</label>
        <Select v-model="settings.blocklist_update_schedule" :options="scheduleOptions"
                optionLabel="label" optionValue="value" size="small" style="width: 10rem" />
      </div>
      <div class="schedule-group">
        <label class="schedule-label" title="Largest single feed download to accept. Raise this if a category fails with a size error.">
          Max Feed Size (MB):
        </label>
        <InputText v-model="maxFeedMb" type="number" min="1" max="2048" size="small" style="width: 6rem" />
      </div>
      <Button label="Save Settings" icon="pi pi-save" size="small" @click="doSaveSettings" :loading="savingSettings" :disabled="!settingsDirty" />
      <Button label="Refresh All" icon="pi pi-refresh" size="small" severity="secondary"
              @click="doRefreshAll" :loading="refreshingAll" />
    </div>

    <!-- Search and Allowed Domains are sibling Filtering sub-tabs now
         (views/settings/BlocklistSearch.vue / BlocklistAllowedDomains.vue). -->
    <DataTable :value="store.categories" :loading="store.loading" stripedRows size="small"
             dataKey="slug"
             :paginator="store.categories.length > 256" :rows="256"
             :rowsPerPageOptions="[64, 128, 256, 512]"
             scrollable scrollHeight="flex">
    <template #empty>
      <EmptyState v-if="!store.loading" icon="pi-ban" title="No categories available" description="The category catalog failed to load. Refresh the page or check the server log." />
    </template>
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
        <span :class="data.group === 'beta' ? 'badge-sm badge-yellow' : 'badge-sm badge-muted'">
          {{ data.group === 'beta' ? 'Beta' : 'Main' }}
        </span>
      </template>
    </Column>
    <Column header="Domains" style="width: 7rem">
      <template #body="{ data }">
        {{ data.domain_count > 0 ? formatNumber(data.domain_count) : EMPTY_CELL }}
      </template>
    </Column>
    <Column header="Last Updated" style="width: 10rem">
      <template #body="{ data }">
        {{ data.last_fetched_at ? formatDate(data.last_fetched_at) : 'Never' }}
      </template>
    </Column>
    <Column header="Status" style="width: 6rem">
      <template #body="{ data }">
        <span v-if="data.last_error" class="badge badge-red" style="cursor: help" :title="data.last_error">Error</span>
        <span v-else-if="data.enabled && data.last_fetched_at" class="badge badge-green">Active</span>
        <span v-else-if="data.enabled" class="badge badge-yellow">Pending</span>
        <span v-else class="badge badge-muted">Off</span>
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

    <Toast />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { formatDateTime } from '../utils/dateFormat.js';
import { formatNumber, apiError, EMPTY_CELL } from '../utils/format.js';
import { useToast } from 'primevue/usetoast';
import EmptyState from '../components/EmptyState.vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Toast from 'primevue/toast';
import ToggleSwitch from 'primevue/toggleswitch';
import { useBlocklistStore } from '../stores/blocklists.js';
import { useDnsStore } from '../stores/dns.js';

const store = useBlocklistStore();
const dnsStore = useDnsStore();
const noRecursion = ref(false);
const toast = useToast();

const stats = ref({ enabled_categories: 0, total_domains: 0, whitelist_count: 0, last_update: null });
const settings = reactive({ blocklist_enabled: 'true', blocklist_redirect_ip: '', blocklist_update_schedule: 'daily', blocklist_max_feed_mb: '128' });
const blocklistEnabled = ref(true);
const savedBlocklistEnabled = ref(true);
// Show the toggle OFF (and locked) while recursion is disabled. Blocking is
// inert then. Non-destructive: the saved preference returns when recursion is on.
const blocklistEnabledDisplay = computed({
  get: () => noRecursion.value ? false : blocklistEnabled.value,
  set: (v) => { if (!noRecursion.value) blocklistEnabled.value = v; },
});
const savedSchedule = ref('daily');
// Kept as a string: the settings API is string-typed and InputText gives us a
// string anyway, so comparing against savedMaxFeedMb stays a plain !==.
const maxFeedMb = ref('128');
const savedMaxFeedMb = ref('128');

const settingsDirty = computed(() => {
  return blocklistEnabled.value !== savedBlocklistEnabled.value ||
    settings.blocklist_update_schedule !== savedSchedule.value ||
    String(maxFeedMb.value) !== savedMaxFeedMb.value;
});

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

// Category blocking only applies to forwarded/recursive queries. When recursion
// is disabled the enable toggle is locked; explain why on a click attempt.
function onEnableClick() {
  if (noRecursion.value) {
    toast.add({
      severity: 'warn',
      summary: 'Recursion is disabled',
      detail: 'Category blocking only applies to recursive queries. Enable recursion in Settings → DNS → Upstream Forwarders first.',
      life: 5000,
    });
  }
}

async function refreshStats() {
  stats.value = await store.fetchStats();
}

async function doSaveUrl(slug) {
  savingUrl.value = true;
  try {
    await store.updateCategoryUrl(slug, editingUrlValue.value.trim());
    editingUrlSlug.value = null;
    toast.add({ severity: 'success', summary: 'URL updated', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingUrl.value = false;
  }
}



const formatDate = formatDateTime;

async function doToggleCategory(cat, enabled) {
  togglingSlug.value = cat.slug;
  try {
    await store.toggleCategory(cat.slug, enabled);
    await refreshStats();
    toast.add({ severity: 'success', summary: `${cat.name} ${enabled ? 'enabled' : 'disabled'}`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    togglingAll.value = false;
    await refreshStats().catch(() => {});
  }
}

async function doRefreshCategory(cat) {
  refreshingSlug.value = cat.slug;
  try {
    await store.refreshCategory(cat.slug);
    await refreshStats();
    toast.add({ severity: 'success', summary: `${cat.name} refreshed`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: apiError(err), life: 5000 });
  } finally {
    refreshingSlug.value = null;
  }
}

async function doRefreshAll() {
  refreshingAll.value = true;
  try {
    await store.refreshAll();
    await refreshStats();
    toast.add({ severity: 'success', summary: 'All categories refreshed', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Refresh failed', detail: apiError(err), life: 5000 });
  } finally {
    refreshingAll.value = false;
  }
}

async function doSaveSettings() {
  savingSettings.value = true;
  try {
    await store.updateSettings({
      blocklist_enabled: blocklistEnabled.value ? 'true' : 'false',
      blocklist_redirect_ip: settings.blocklist_redirect_ip,
      blocklist_update_schedule: settings.blocklist_update_schedule,
      blocklist_max_feed_mb: String(maxFeedMb.value)
    });
    savedBlocklistEnabled.value = blocklistEnabled.value;
    savedSchedule.value = settings.blocklist_update_schedule;
    savedMaxFeedMb.value = String(maxFeedMb.value);
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

onMounted(async () => {
  const [, fetchedSettings] = await Promise.all([
    store.fetchCategories(),
    store.fetchSettings(),
    refreshStats(),
  ]);
  Object.assign(settings, fetchedSettings);
  blocklistEnabled.value = fetchedSettings.blocklist_enabled !== 'false';
  savedBlocklistEnabled.value = blocklistEnabled.value;
  savedSchedule.value = settings.blocklist_update_schedule;
  maxFeedMb.value = settings.blocklist_max_feed_mb || '128';
  savedMaxFeedMb.value = String(maxFeedMb.value);
  try { noRecursion.value = !!(await dnsStore.getForwarders()).no_recursion; } catch { /* ignore */ }
});
</script>

<style>
@import '../assets/analytics-layout.css';
</style>

<style scoped>
.blocklists-page { }
.blocklists-page h2 {
  margin: 0 0 1rem 0;
}

.text-sm { font-size: 0.8rem; }
.muted { color: var(--p-text-muted-color); }


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
