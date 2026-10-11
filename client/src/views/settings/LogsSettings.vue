<!-- Logging: a tab per role (DNS, DHCP) showing the log of the server filling
     it (GET /api/logs/sources, LogViewer), and an Audit Log tab (DataTable +
     filters + pagination). Loads the sources, audit filter options and audit
     log on mount. -->
<template>
  <div class="fill-panel">
    <Tabs v-model:value="activeTab" class="logging-subtabs">
      <TabList>
        <Tab
          v-for="source in logSources"
          :key="source.role"
          :value="source.role"
          :data-track="`logs-tab-${source.role}`"
          >{{ ROLE_TITLE[source.role] }} ({{ source.label }})</Tab
        >
        <Tab value="audit" data-track="logs-tab-audit">Audit Log</Tab>
      </TabList>
      <TabPanels>
        <TabPanel v-for="source in logSources" :key="source.role" :value="source.role">
          <LogViewer
            v-if="source.available"
            :key="`${source.role}-${source.label}`"
            :role="source.role"
            :clearable="source.clearable"
          />
          <EmptyState
            v-else
            icon="pi-file"
            :title="source.message"
            description="Queries and leases are under Analytics and the Networks workspace."
          />
        </TabPanel>
        <TabPanel value="audit">
          <div class="audit-section">
            <div class="audit-filters">
              <MultiSelect
                v-model="auditFilters.action"
                :options="auditActionOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="All Actions"
                :maxSelectedLabels="2"
                class="audit-filter"
                display="chip"
              />
              <MultiSelect
                v-model="auditFilters.origin"
                :options="AUDIT_ORIGIN_OPTIONS"
                optionLabel="label"
                optionValue="value"
                placeholder="Everyone"
                :maxSelectedLabels="2"
                class="audit-filter"
                display="chip"
                data-track="audit-filter-origin"
              />
              <MultiSelect
                v-model="auditFilters.entity_type"
                :options="auditEntityOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="All Entities"
                :maxSelectedLabels="2"
                class="audit-filter"
                display="chip"
              />
              <Button
                icon="pi pi-refresh"
                severity="secondary"
                text
                rounded
                @click="loadAuditLog"
              />
            </div>
            <DataTable
              :value="auditLog.items"
              :loading="loadingAudit"
              stripedRows
              size="small"
              scrollable
              scrollHeight="flex"
            >
              <template #empty>
                <EmptyState
                  icon="pi-list"
                  title="No audit entries"
                  description="Actions will appear here as configuration changes are made."
                />
              </template>
              <Column field="created_at" header="Time" style="width: 11rem">
                <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
              </Column>
              <Column field="username" header="Who" style="width: 10rem">
                <template #body="{ data }">
                  {{ actorLabel(data) }}
                  <span v-if="originNote(data)" class="muted text-sm">{{ originNote(data) }}</span>
                </template>
              </Column>
              <Column field="source_ip" header="Source IP" style="width: 9rem">
                <template #body="{ data }">
                  <span class="mono text-sm">{{ data.source_ip || EMPTY_CELL }}</span>
                </template>
              </Column>
              <Column field="action" header="Action" style="width: 8rem">
                <template #body="{ data }">
                  <span class="badge" :class="'badge-' + actionColor(data.action)">{{
                    data.action
                  }}</span>
                </template>
              </Column>
              <Column field="entity_type" header="Entity" style="width: 8rem" />
              <Column field="entity_id" header="ID" style="width: 4rem" />
              <Column header="Details">
                <template #body="{ data }">
                  <span class="audit-details" :title="formatDetails(data.details)">{{
                    formatDetails(data.details)
                  }}</span>
                </template>
              </Column>
            </DataTable>
            <div class="audit-pagination" v-if="auditLog.total > auditFilters.limit">
              <Button
                label="Previous"
                severity="secondary"
                size="small"
                :disabled="auditFilters.page <= 1"
                @click="
                  auditFilters.page--;
                  loadAuditLog();
                "
              />
              <span class="page-info"
                >Page {{ auditFilters.page }} of
                {{ Math.ceil(auditLog.total / auditFilters.limit) }}</span
              >
              <Button
                label="Next"
                severity="secondary"
                size="small"
                :disabled="auditFilters.page >= Math.ceil(auditLog.total / auditFilters.limit)"
                @click="
                  auditFilters.page++;
                  loadAuditLog();
                "
              />
            </div>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, defineAsyncComponent } from 'vue';
import { useToast } from '../../ui/useToast.js';
import Tabs from '../../ui/Tabs.js';
import TabList from '../../ui/TabList.js';
import Tab from '../../ui/Tab.js';
import TabPanels from '../../ui/TabPanels.js';
import EmptyState from '../../components/EmptyState.vue';
import TabPanel from '../../ui/TabPanel.js';
import Button from '../../ui/Button.js';
import DataTable from '../../ui/DataTable.js';
import Column from '../../ui/Column.js';
import MultiSelect from '../../ui/MultiSelect.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import { apiError, EMPTY_CELL } from '../../utils/format.js';
import api from '../../api/client.js';

const LogViewer = defineAsyncComponent(() => import('../../components/LogViewer.vue'));

const toast = useToast();

const ROLE_TITLE = { dns: 'DNS', dhcp: 'DHCP' };
const logSources = ref([]);
const activeTab = ref('dns');

async function loadLogSources() {
  try {
    logSources.value = (await api.get('/logs/sources')).data;
  } catch (err) {
    activeTab.value = 'audit';
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

// Audit Log
const loadingAudit = ref(false);
const auditLog = ref({ items: [], total: 0 });
// The API returns at most 100 rows a page.
const auditFilters = ref({ page: 1, limit: 100, action: [], entity_type: [], origin: [] });

// How an entry came about: a sign-in, an API token, the updater run from a
// shell, or CIDRella on its own (server routes/audit.js).
const AUDIT_ORIGIN_OPTIONS = [
  { label: 'People', value: 'ui' },
  { label: 'API tokens', value: 'api-token' },
  { label: 'Updates from a shell', value: 'cli' },
  { label: 'System', value: 'system' },
];

function actorLabel(row) {
  // CIDRella's own rows, an update run from a shell among them, name what acted.
  if (!row.username || row.username === 'system') {
    return row.source ? `System · ${row.source}` : 'System';
  }
  return row.username || 'System';
}

function originNote(row) {
  if (row.origin === 'api-token') return 'API token';
  if (row.origin === 'cli') return 'shell';
  return '';
}

const auditActionOptions = ref([]);
const auditEntityOptions = ref([]);

async function loadAuditFilterOptions() {
  try {
    const [actionsRes, entitiesRes] = await Promise.all([
      api.get('/audit/actions'),
      api.get('/audit/entities'),
    ]);
    auditActionOptions.value = actionsRes.data.map((a) => ({ label: a, value: a }));
    auditEntityOptions.value = entitiesRes.data.map((e) => ({ label: e, value: e }));
  } catch {
    /* ignore, filters will just be empty */
  }
}

// Auto-refresh when filters change
watch(
  () => auditFilters.value.action,
  () => {
    auditFilters.value.page = 1;
    loadAuditLog();
  },
  { deep: true },
);
watch(
  () => auditFilters.value.origin,
  () => {
    auditFilters.value.page = 1;
    loadAuditLog();
  },
  { deep: true },
);
watch(
  () => auditFilters.value.entity_type,
  () => {
    auditFilters.value.page = 1;
    loadAuditLog();
  },
  { deep: true },
);

async function loadAuditLog() {
  loadingAudit.value = true;
  try {
    const params = { page: auditFilters.value.page, limit: auditFilters.value.limit };
    if (auditFilters.value.action?.length > 0) params.action = auditFilters.value.action.join(',');
    if (auditFilters.value.entity_type?.length > 0)
      params.entity_type = auditFilters.value.entity_type.join(',');
    if (auditFilters.value.origin?.length > 0) params.origin = auditFilters.value.origin.join(',');
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
  const direct = {
    create: 'green',
    update: 'blue',
    delete: 'red',
    restore: 'indigo',
    login: 'indigo',
    login_failed: 'red',
    password_change: 'yellow',
    configure: 'purple',
    divide: 'yellow',
    merge: 'orange',
  };
  if (direct[action]) return direct[action];
  // Map compound actions by verb suffix
  if (action.endsWith('_created')) return 'green';
  if (action.endsWith('_updated')) return 'blue';
  if (action.endsWith('_deleted')) return 'red';
  if (action.endsWith('_configured') || action.endsWith('_applied')) return 'purple';
  if (action.endsWith('_divided')) return 'yellow';
  if (action.endsWith('_merged')) return 'orange';
  if (action.endsWith('_failed') || action.endsWith('_activated')) return 'red';
  if (action.endsWith('_restored') || action.endsWith('_deactivated')) return 'indigo';
  if (action.endsWith('_started') || action.endsWith('_restarted')) return 'indigo';
  if (action.endsWith('_reset')) return 'yellow';
  if (action.endsWith('_changed')) return 'blue';
  return 'blue'; // fallback
}

// One value in a details line: a bulk sample as its count and first items,
// a list joined, anything else nested as compact JSON.
function formatValue(value) {
  if (value === null || value === undefined || value === '') return EMPTY_CELL;
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') {
    if (Number.isInteger(value.count) && (value.items || value.first)) {
      const shown = (value.items || value.first).map(formatValue).join(', ');
      return value.first ? `${value.count} (${shown}, …)` : `${value.count} (${shown})`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

// An entry's details as one line. An edit's `changes` ({ field: [old, new] },
// services/audit.js on the server) read as `field: old → new`.
function formatDetails(details) {
  if (!details) return EMPTY_CELL;
  try {
    const obj = typeof details === 'string' ? JSON.parse(details) : details;
    if (typeof obj !== 'object') return String(obj);
    const parts = [];
    // Entries from before 0.5.3 kept the request body under `changes`.
    const diff =
      obj.changes &&
      typeof obj.changes === 'object' &&
      Object.values(obj.changes).every((pair) => Array.isArray(pair) && pair.length === 2);
    if (diff) {
      for (const [field, [was, now]] of Object.entries(obj.changes)) {
        parts.push(`${field}: ${formatValue(was)} → ${formatValue(now)}`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if ((diff && k === 'changes') || v === null || v === undefined) continue;
      parts.push(`${k}: ${formatValue(v)}`);
    }
    return parts.join(', ') || EMPTY_CELL;
  } catch {
    return String(details);
  }
}

onMounted(() => {
  loadLogSources();
  loadAuditFilterOptions();
  loadAuditLog();
});
</script>

<style scoped>
.content-card {
  margin: 0;
  padding: 1.25rem;
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
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
  color: var(--cid-text-muted-color);
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
  color: var(--cid-text-muted-color);
}
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
