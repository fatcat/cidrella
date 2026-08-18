<!-- Logging. Extracted from System.vue tab 11 (1:1): inner Tabs with a DNSmasq
     tab (LogViewer component) and an Audit Log tab (DataTable + filters + pagination).
     Loads audit filter options + audit log on mount. -->
<template>
  <div>
    <Tabs value="dnsmasq" class="logging-subtabs">
      <TabList>
        <Tab value="dnsmasq">DNSmasq</Tab>
        <Tab value="audit">Audit Log</Tab>
      </TabList>
      <TabPanels>
      <TabPanel value="dnsmasq">
        <LogViewer />
      </TabPanel>
      <TabPanel value="audit">
        <div class="audit-section">
          <div class="audit-filters">
            <MultiSelect v-model="auditFilters.action" :options="auditActionOptions" optionLabel="label" optionValue="value"
                    placeholder="All Actions" :maxSelectedLabels="2" class="audit-filter" display="chip" />
            <MultiSelect v-model="auditFilters.entity_type" :options="auditEntityOptions" optionLabel="label" optionValue="value"
                    placeholder="All Entities" :maxSelectedLabels="2" class="audit-filter" display="chip" />
            <Button icon="pi pi-refresh" severity="secondary" text rounded @click="loadAuditLog" />
          </div>
          <DataTable :value="auditLog.items" :loading="loadingAudit" stripedRows size="small"
                    
                     scrollable scrollHeight="flex">
            <template #empty>
              <EmptyState icon="pi-list" title="No audit entries" description="Actions will appear here as configuration changes are made." />
            </template>
            <Column field="created_at" header="Time" style="width: 11rem">
              <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
            </Column>
            <Column field="username" header="User" style="width: 8rem">
              <template #body="{ data }">{{ data.username || 'system' }}</template>
            </Column>
            <Column field="action" header="Action" style="width: 8rem">
              <template #body="{ data }">
                <span class="badge" :class="'badge-' + actionColor(data.action)">{{ data.action }}</span>
              </template>
            </Column>
            <Column field="entity_type" header="Entity" style="width: 8rem" />
            <Column field="entity_id" header="ID" style="width: 4rem" />
            <Column header="Details">
              <template #body="{ data }">
                <span class="audit-details">{{ formatDetails(data.details) }}</span>
              </template>
            </Column>
          </DataTable>
          <div class="audit-pagination" v-if="auditLog.total > auditFilters.limit">
            <Button label="Previous" severity="secondary" size="small" :disabled="auditFilters.page <= 1"
                    @click="auditFilters.page--; loadAuditLog()" />
            <span class="page-info">Page {{ auditFilters.page }} of {{ Math.ceil(auditLog.total / auditFilters.limit) }}</span>
            <Button label="Next" severity="secondary" size="small"
                    :disabled="auditFilters.page >= Math.ceil(auditLog.total / auditFilters.limit)"
                    @click="auditFilters.page++; loadAuditLog()" />
          </div>
        </div>
      </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, defineAsyncComponent } from 'vue';
import { useToast } from 'primevue/usetoast';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import EmptyState from '../../components/EmptyState.vue';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import MultiSelect from 'primevue/multiselect';
import { formatDateTime } from '../../utils/dateFormat.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import api from '../../api/client.js';

const LogViewer = defineAsyncComponent(() => import('../../components/LogViewer.vue'));

const toast = useToast();

// Audit Log
const loadingAudit = ref(false);
const auditLog = ref({ items: [], total: 0 });
const auditFilters = ref({ page: 1, limit: 200, action: [], entity_type: [] });

const auditActionOptions = ref([]);
const auditEntityOptions = ref([]);

async function loadAuditFilterOptions() {
  try {
    const [actionsRes, entitiesRes] = await Promise.all([
      api.get('/audit/actions'),
      api.get('/audit/entities')
    ]);
    auditActionOptions.value = actionsRes.data.map(a => ({ label: a, value: a }));
    auditEntityOptions.value = entitiesRes.data.map(e => ({ label: e, value: e }));
  } catch { /* ignore, filters will just be empty */ }
}

// Auto-refresh when filters change
watch(() => auditFilters.value.action, () => { auditFilters.value.page = 1; loadAuditLog(); }, { deep: true });
watch(() => auditFilters.value.entity_type, () => { auditFilters.value.page = 1; loadAuditLog(); }, { deep: true });

async function loadAuditLog() {
  loadingAudit.value = true;
  try {
    const params = { page: auditFilters.value.page, limit: auditFilters.value.limit };
    if (auditFilters.value.action?.length > 0) params.action = auditFilters.value.action.join(',');
    if (auditFilters.value.entity_type?.length > 0) params.entity_type = auditFilters.value.entity_type.join(',');
    const res = await api.get('/audit', { params });
    auditLog.value = res.data;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    loadingAudit.value = false;
  }
}

const formatDate = formatDateTime;

function actionColor(action) {
  // Direct matches → global badge color class names
  const direct = { create: 'green', update: 'blue', delete: 'red', restore: 'indigo',
    login: 'indigo', login_failed: 'red', password_change: 'yellow',
    configure: 'purple', divide: 'yellow', merge: 'orange' };
  if (direct[action]) return direct[action];
  // Map compound actions by verb suffix
  if (action.endsWith('_created')) return 'green';
  if (action.endsWith('_updated')) return 'blue';
  if (action.endsWith('_deleted')) return 'red';
  if (action.endsWith('_configured') || action.endsWith('_applied')) return 'purple';
  if (action.endsWith('_divided')) return 'yellow';
  if (action.endsWith('_merged')) return 'orange';
  if (action.endsWith('_started')) return 'indigo';
  if (action.endsWith('_reset')) return 'yellow';
  if (action.endsWith('_changed')) return 'blue';
  return 'blue'; // fallback
}

function formatDetails(details) {
  if (!details) return EMPTY_CELL;
  try {
    const obj = typeof details === 'string' ? JSON.parse(details) : details;
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) parts.push(`${k}: ${v}`);
    }
    return parts.join(', ') || EMPTY_CELL;
  } catch { return String(details); }
}

onMounted(() => {
  loadAuditFilterOptions();
  loadAuditLog();
});
</script>

<style scoped>
.content-card {
  margin: 0;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}
.padded-tab {
  margin: 0 7%;
}
.audit-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}
.audit-filters {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.audit-filter {
  min-width: 14rem;
  max-width: 22rem;
}
.audit-details {
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
  max-width: 30rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
.audit-pagination {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
}
.page-info {
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
}
.w-full { width: 100%; }
.logging-subtabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.logging-subtabs :deep(.p-tabpanels) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.logging-subtabs :deep(.p-tabpanel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
