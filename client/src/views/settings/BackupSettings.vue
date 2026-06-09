<!-- Backup & Restore. Extracted from System.vue tab 3 (1:1) — manual backup, schedule,
     backups table + row context menu, restore, delete-backup dialog, and admin-gated
     Database Reset. Loads on mount. -->
<template>
  <div class="content-card">
    <div class="backup-section">
      <div class="setting-group">
        <h3>Manual Backup</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">Creates a backup of the database, certificates, and DNSmasq configuration.</p>
        <Button label="Create Backup" icon="pi pi-download" size="small" data-track="sys-create-backup-inline" @click="doCreateBackup" :loading="creatingBackup" />
      </div>

      <div class="setting-group">
        <h3>Schedule</h3>
        <div class="field">
          <label>Automatic Backups</label>
          <Select v-model="backupSchedule" :options="scheduleOptions" optionLabel="label" optionValue="value"
                  class="w-full" style="max-width: 16rem;" @change="saveBackupSettings" />
        </div>
        <div class="field">
          <label>Retention (max backups to keep)</label>
          <InputText v-model.number="backupRetention" type="number" min="1" max="100"
                     style="width: 8rem;" @change="saveBackupSettings" />
        </div>
        <div class="field">
          <label>Next Backup</label>
          <span class="next-backup-value">{{ nextBackupLabel }}</span>
        </div>
      </div>

      <div class="setting-group">
        <h3>Existing Backups</h3>
        <DataTable :value="opsStore.backups" :loading="opsStore.loading" stripedRows size="small"
                   emptyMessage="No backups found."
                   @row-contextmenu="onBackupRightClick" contextMenu>
          <Column field="filename" header="Filename" />
          <Column header="Size" style="width: 8rem">
            <template #body="{ data }">{{ formatSize(data.size_bytes) }}</template>
          </Column>
          <Column header="Created" style="width: 12rem">
            <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
          </Column>
          <Column header="" style="width: 5rem; text-align: right;">
            <template #body="{ data }">
              <div class="action-buttons">
                <Button icon="pi pi-download" severity="secondary" text rounded size="small"
                        v-tooltip.top="'Download'" @click="opsStore.downloadBackup(data.id, data.filename)" />
                <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                        v-tooltip.top="'Delete'" @click="confirmDeleteBackup(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
      </div>

      <div class="setting-group">
        <h3>Restore from Backup</h3>
        <p class="field-help restore-warning">Warning: Restoring will replace all current data. A server restart will be required.</p>
        <div class="restore-row">
          <input type="file" ref="restoreFileInput" accept=".tar.gz,.tgz" @change="onRestoreFileSelected" />
          <Button label="Restore" icon="pi pi-upload" severity="danger" @click="showRestoreDialog = true"
                  :disabled="!restoreFile" />
        </div>
      </div>

      <div class="setting-group" v-if="authStore.user?.role === 'admin'">
        <h3 style="color: var(--p-red-500);">Database Reset</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">
          Reset the application to a fresh state. This will delete all networks, DNS zones, DHCP scopes,
          users, audit logs, settings, and VLANs. TLS certificates, backup files, and blocklist files on disk are preserved.
        </p>
        <Button label="Reset Database" icon="pi pi-exclamation-triangle" severity="danger"
                @click="showResetDbDialog = true" />
      </div>
    </div>

    <ContextMenu ref="backupContextMenuRef" :model="backupContextMenuItems" />

    <!-- Delete Backup Dialog -->
    <Dialog v-model:visible="showDeleteBackupDialog" header="Delete Backup" modal :style="{ width: '24rem' }">
      <p>Delete backup <strong>{{ deletingBackup?.filename }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteBackupDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteBackup" :loading="deletingBackupLoading" />
      </template>
    </Dialog>

    <!-- Database Reset Confirmation Dialog -->
    <Dialog v-model:visible="showResetDbDialog" header="Reset Database" modal :style="{ width: '28rem' }">
      <p style="color: var(--p-red-500); font-weight: 600;">This action cannot be undone.</p>
      <p>All application data will be permanently deleted and the database will be reinitialized.
         You will be logged out and a new admin account will be generated.</p>
      <p>Type <strong>RESET</strong> to confirm:</p>
      <InputText v-model="resetConfirmText" class="w-full" placeholder="Type RESET" />
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showResetDbDialog = false; resetConfirmText = ''" />
        <Button label="Reset Database" severity="danger" @click="doResetDatabase"
                :loading="resettingDb" :disabled="resetConfirmText !== 'RESET'" />
      </template>
    </Dialog>

    <!-- Restore Confirmation Dialog -->
    <Dialog v-model:visible="showRestoreDialog" header="Confirm Restore" modal :style="{ width: '28rem' }">
      <p>This will <strong>replace all current data</strong> with the contents of the backup file. The server will need to be restarted after restore.</p>
      <p>Are you sure you want to proceed?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showRestoreDialog = false" />
        <Button label="Restore Now" severity="danger" @click="doRestore" :loading="restoring" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import ContextMenu from 'primevue/contextmenu';
import { useToast } from 'primevue/usetoast';
import { useSubnetStore } from '../../stores/subnets.js';
import { useOperationsStore } from '../../stores/operations.js';
import { useAuthStore } from '../../stores/auth.js';
import { apiError } from '../../utils/format.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import api from '../../api/client.js';

const store = useSubnetStore();
const opsStore = useOperationsStore();
const authStore = useAuthStore();
const toast = useToast();

const formatDate = formatDateTime;

const creatingBackup = ref(false);
const deletingBackup = ref(null);
const deletingBackupLoading = ref(false);
const showDeleteBackupDialog = ref(false);
const showResetDbDialog = ref(false);
const resetConfirmText = ref('');
const resettingDb = ref(false);
const showRestoreDialog = ref(false);
const restoreFile = ref(null);
const restoreFileInput = ref(null);
const restoring = ref(false);
const backupSchedule = ref('off');
const backupRetention = ref(7);
const backupLastRun = ref(null);

const scheduleOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' }
];

const INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};

const nextBackupLabel = computed(() => {
  if (backupSchedule.value === 'off') return 'None scheduled';
  const interval = INTERVAL_MS[backupSchedule.value];
  if (!interval) return 'None scheduled';
  const lastRun = backupLastRun.value ? new Date(backupLastRun.value).getTime() : 0;
  if (!lastRun) return 'Pending — will run within 15 minutes';
  const nextTime = new Date(lastRun + interval);
  if (nextTime.getTime() <= Date.now()) return 'Pending — will run within 15 minutes';
  return formatDateTime(nextTime.toISOString());
});

async function loadBackupSettings() {
  try {
    const data = await store.getSettings();
    backupSchedule.value = data.backup_schedule || 'off';
    backupRetention.value = parseInt(data.backup_retention_count || '7', 10);
    backupLastRun.value = data.backup_last_run || null;
  } catch {}
}

async function saveBackupSettings() {
  const previousSchedule = backupSchedule.value;
  try {
    await api.put('/settings/bulk', {
      settings: {
        backup_schedule: backupSchedule.value,
        backup_retention_count: String(backupRetention.value),
      }
    });
    toast.add({ severity: 'success', summary: 'Backup settings saved', life: 3000 });

    // If enabling a schedule and no backups exist, create one immediately
    if (backupSchedule.value !== 'off' && opsStore.backups.length === 0) {
      creatingBackup.value = true;
      try {
        const backup = await opsStore.createBackup();
        // Record as the last scheduled run so next backup is scheduled correctly
        await store.updateSetting('backup_last_run', new Date().toISOString());
        toast.add({ severity: 'success', summary: `Initial backup created: ${backup.filename}`, life: 5000 });
        await loadBackupSettings();
      } catch (err) {
        toast.add({ severity: 'error', summary: 'Initial backup failed', detail: apiError(err), life: 5000 });
      } finally {
        creatingBackup.value = false;
      }
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function doCreateBackup() {
  creatingBackup.value = true;
  try {
    const backup = await opsStore.createBackup();
    toast.add({ severity: 'success', summary: `Backup created: ${backup.filename}`, life: 5000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Backup failed', detail: apiError(err), life: 5000 });
  } finally {
    creatingBackup.value = false;
  }
}

function confirmDeleteBackup(backup) {
  deletingBackup.value = backup;
  showDeleteBackupDialog.value = true;
}

async function doDeleteBackup() {
  deletingBackupLoading.value = true;
  try {
    await opsStore.deleteBackup(deletingBackup.value.id);
    showDeleteBackupDialog.value = false;
    toast.add({ severity: 'success', summary: 'Backup deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    deletingBackupLoading.value = false;
  }
}

// Backups context menu
const backupContextMenuRef = ref();
const selectedBackup = ref(null);
const backupContextMenuItems = computed(() => {
  const b = selectedBackup.value;
  if (!b) return [];
  return [
    { label: 'Download', icon: 'pi pi-download', command: () => opsStore.downloadBackup(b.id, b.filename) },
    { label: 'Delete', icon: 'pi pi-trash', command: () => confirmDeleteBackup(b) }
  ];
});
function onBackupRightClick(event) {
  selectedBackup.value = event.data;
  backupContextMenuRef.value.show(event.originalEvent);
}

function onRestoreFileSelected(e) {
  restoreFile.value = e.target.files[0] || null;
}

async function doRestore() {
  if (!restoreFile.value) return;
  restoring.value = true;
  try {
    const result = await opsStore.restoreBackup(restoreFile.value);
    showRestoreDialog.value = false;
    toast.add({ severity: 'warn', summary: 'Restore complete', detail: result.message, life: 10000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Restore failed', detail: apiError(err), life: 5000 });
  } finally {
    restoring.value = false;
  }
}

async function doResetDatabase() {
  resettingDb.value = true;
  try {
    await api.post('/operations/reset-database');
    authStore.logout();
    window.location.href = '/login';
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: apiError(err), life: 5000 });
  } finally {
    resettingDb.value = false;
    showResetDbDialog.value = false;
    resetConfirmText.value = '';
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

onMounted(async () => {
  await Promise.all([
    opsStore.fetchBackups(),
    loadBackupSettings()
  ]);
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
.content-card h3 {
  font-size: var(--app-fs-lg);
  margin: 0 0 0.75rem;
  color: var(--p-text-color);
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.card-header h3 {
  margin: 0;
}
.setting-group {
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.setting-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.setting-group h3 {
  margin: 0 0 0.75rem 0;
  font-size: var(--app-fs-lg);
  color: var(--p-text-color);
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
}
.field-help {
  display: block;
  margin-top: 0.25rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
}
.settings-actions {
  margin-top: 1rem;
  display: flex;
  justify-content: flex-end;
}
.backup-section {
  max-width: 48rem;
}
.next-backup-value {
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
}
.restore-warning {
  color: var(--p-red-500);
  font-weight: 600;
}
.restore-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.w-full {
  width: 100%;
}
</style>
