<template>
  <div class="update-panel">
    <!-- Version Info -->
    <div class="content-card settings-form">
      <h3>Version</h3>
      <div class="version-row">
        <div class="version-info">
          <span class="version-label">Current version</span>
          <span class="version-number">v{{ versionInfo?.version || '...' }}</span>
        </div>
        <div class="version-actions">
          <span v-if="versionInfo?.lastChecked" class="last-checked">
            Last checked {{ formatRelative(versionInfo.lastChecked) }}
          </span>
          <Button label="Check Now" icon="pi pi-refresh" size="small" text
                  data-track="update-check-now"
                  :loading="checking" @click="checkForUpdate" />
        </div>
      </div>
    </div>

    <!-- Docker Notice -->
    <div v-if="versionInfo?.isDocker" class="content-card docker-notice">
      <i class="pi pi-info-circle"></i>
      <div>
        <strong>Docker deployment detected</strong>
        <p>In-app updates are not available for Docker deployments. Pull the latest image to update.</p>
      </div>
    </div>

    <!-- Available Update -->
    <div v-else-if="versionInfo?.updateAvailable && !isUpdating && updateStatus?.state !== 'completed'" class="content-card update-available">
      <div class="update-header">
        <div>
          <h3>Update Available</h3>
          <p class="update-version">
            v{{ versionInfo.version }} <i class="pi pi-arrow-right"></i> v{{ versionInfo.updateAvailable }}
          </p>
        </div>
        <div class="update-actions">
          <a v-if="versionInfo.updateUrl" :href="versionInfo.updateUrl" target="_blank"
             class="release-link" data-track="update-release-notes">
            <i class="pi pi-external-link"></i> Release Notes
          </a>
          <Button label="Install Update" icon="pi pi-download" severity="success"
                  data-track="update-install"
                  :loading="installing" @click="confirmInstall" />
        </div>
      </div>
    </div>

    <!-- Up to Date -->
    <div v-else-if="!versionInfo?.updateAvailable && !isUpdating && updateStatus?.state !== 'completed'" class="content-card up-to-date">
      <i class="pi pi-check-circle"></i>
      <span>CIDRella is up to date</span>
    </div>

    <!-- Update Progress -->
    <div v-if="isUpdating || updateStatus?.state === 'completed' || updateStatus?.state === 'failed'" class="content-card update-progress">
      <h3>{{ reconnecting ? 'Restarting...' : 'Update Progress' }}</h3>

      <!-- Reconnecting Overlay -->
      <div v-if="reconnecting" class="reconnecting-overlay">
        <i class="pi pi-spin pi-spinner reconnecting-spinner"></i>
        <p>CIDRella is restarting with the new version...</p>
        <small>This may take a moment. The page will refresh automatically.</small>
      </div>

      <!-- Step Indicator -->
      <div v-else class="update-steps">
        <div v-for="step in updateSteps" :key="step.key"
             class="update-step" :class="stepClass(step.key)">
          <div class="step-icon">
            <i v-if="isStepDone(step.key)" class="pi pi-check"></i>
            <i v-else-if="isStepActive(step.key)" class="pi pi-spin pi-spinner"></i>
            <span v-else class="step-dot"></span>
          </div>
          <span class="step-label">{{ step.label }}</span>
        </div>
      </div>

      <!-- Progress Bar -->
      <ProgressBar v-if="isUpdating" :value="updateStatus?.progress_pct || 0"
                   :showValue="true" style="margin-top: 1rem;" />

      <!-- Status Message -->
      <p v-if="updateStatus?.message && !reconnecting" class="status-message">
        {{ updateStatus.message }}
      </p>

      <!-- Completed -->
      <div v-if="updateStatus?.state === 'completed'" class="update-result success">
        <i class="pi pi-check-circle"></i>
        <div>
          <strong>Update complete</strong>
          <p>Updated from v{{ updateStatus.from_version }} to v{{ updateStatus.to_version }}</p>
        </div>
        <Button label="Dismiss" icon="pi pi-times" size="small" text
                data-track="update-dismiss" @click="dismissStatus" />
      </div>

      <!-- Failed -->
      <div v-if="updateStatus?.state === 'failed'" class="update-result error">
        <i class="pi pi-times-circle"></i>
        <div>
          <strong>Update failed</strong>
          <p>{{ updateStatus.error || 'An unknown error occurred.' }}</p>
          <p v-if="updateStatus.backup_path" class="rollback-hint">
            Rollback available at: <code>{{ updateStatus.backup_path }}</code>
          </p>
        </div>
        <Button label="Dismiss" icon="pi pi-times" size="small" text
                data-track="update-dismiss-error" @click="dismissStatus" />
      </div>
    </div>

    <!-- Settings -->
    <div class="content-card settings-form">
      <h3>Settings</h3>
      <div class="field field-inline">
        <label>Check for updates automatically</label>
        <ToggleSwitch v-model="updateCheckEnabled" data-track="update-check-toggle"
                      @update:modelValue="saveSettings" />
      </div>
    </div>

    <!-- Confirmation Dialog -->
    <Dialog v-model:visible="showConfirmDialog" header="Install Update" :modal="true"
            :closable="true" :style="{ width: '28rem' }">
      <p>
        This will update CIDRella from <strong>v{{ versionInfo?.version }}</strong> to
        <strong>v{{ versionInfo?.updateAvailable }}</strong>.
      </p>
      <p>The server will restart during the update. You may briefly lose connectivity.</p>
      <template #footer>
        <Button label="Cancel" text @click="showConfirmDialog = false" />
        <Button label="Install" icon="pi pi-download" severity="success"
                data-track="update-confirm-install" @click="startInstall" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import Button from 'primevue/button';
import ProgressBar from 'primevue/progressbar';
import ToggleSwitch from 'primevue/toggleswitch';
import Dialog from 'primevue/dialog';
import { useToast } from 'primevue/usetoast';
import api from '../api/client.js';

const toast = useToast();

const versionInfo = ref(null);
const updateStatus = ref(null);
const checking = ref(false);
const installing = ref(false);
const reconnecting = ref(false);
const showConfirmDialog = ref(false);
const updateCheckEnabled = ref(true);

let pollTimer = null;
let reconnectTimer = null;

const updateSteps = [
  { key: 'downloading', label: 'Downloading release' },
  { key: 'verifying', label: 'Verifying signature' },
  { key: 'backing_up', label: 'Creating backup' },
  { key: 'extracting', label: 'Extracting files' },
  { key: 'installing_deps', label: 'Installing dependencies' },
  { key: 'updating_services', label: 'Updating services' },
  { key: 'restarting', label: 'Restarting server' },
];

const stepOrder = updateSteps.map(s => s.key);

const isUpdating = computed(() => {
  const s = updateStatus.value?.state;
  return s && s !== 'idle' && s !== 'completed' && s !== 'failed';
});

function stepIndex(key) {
  return stepOrder.indexOf(key);
}

function isStepDone(key) {
  const current = updateStatus.value?.state;
  if (current === 'completed') return true;
  if (current === 'failed') return stepIndex(key) < stepIndex(current);
  return stepIndex(key) < stepIndex(current);
}

function isStepActive(key) {
  return updateStatus.value?.state === key;
}

function stepClass(key) {
  if (isStepDone(key)) return 'done';
  if (isStepActive(key)) return 'active';
  return 'pending';
}

function formatRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function fetchVersionInfo() {
  try {
    const res = await api.get('/version');
    versionInfo.value = res.data;
    updateCheckEnabled.value = res.data.updateCheckEnabled;
  } catch { /* ignore */ }
}

async function fetchUpdateStatus() {
  try {
    const res = await api.get('/version/update-status');
    updateStatus.value = res.data;

    if (res.data.state === 'restarting') {
      startReconnecting();
    }
  } catch {
    // API unreachable — if we were updating, we're in the restart phase
    if (isUpdating.value) {
      startReconnecting();
    }
  }
}

async function checkForUpdate() {
  checking.value = true;
  try {
    const res = await api.post('/version/check');
    versionInfo.value = { ...versionInfo.value, ...res.data };
    if (res.data.updateAvailable) {
      toast.add({ severity: 'info', summary: 'Update available', detail: `v${res.data.updateAvailable}`, life: 4000 });
    } else {
      toast.add({ severity: 'info', summary: 'Up to date', detail: 'No updates available', life: 3000 });
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Check failed', detail: err.response?.data?.error || 'Could not check for updates', life: 4000 });
  } finally {
    checking.value = false;
  }
}

function confirmInstall() {
  showConfirmDialog.value = true;
}

async function startInstall() {
  showConfirmDialog.value = false;
  installing.value = true;
  try {
    await api.post('/version/install');
    toast.add({ severity: 'info', summary: 'Update started', detail: 'Installing update...', life: 3000 });
    startPolling();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: err.response?.data?.error || 'Could not start update', life: 5000 });
  } finally {
    installing.value = false;
  }
}

async function dismissStatus() {
  try {
    await api.post('/version/update-dismiss');
    updateStatus.value = { state: 'idle' };
    await fetchVersionInfo();
  } catch { /* ignore */ }
}

async function saveSettings() {
  try {
    await api.put('/settings', { update_check_enabled: updateCheckEnabled.value ? 'true' : 'false' });
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 });
  } catch {
    toast.add({ severity: 'error', summary: 'Failed to save settings', life: 3000 });
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(fetchUpdateStatus, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startReconnecting() {
  if (reconnecting.value) return;
  reconnecting.value = true;
  stopPolling();

  const startTime = Date.now();
  const maxWait = 120000; // 2 minutes

  reconnectTimer = setInterval(async () => {
    try {
      await api.get('/health');
      // Server is back — fetch final state
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      reconnecting.value = false;
      await fetchVersionInfo();
      await fetchUpdateStatus();
    } catch {
      if (Date.now() - startTime > maxWait) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        reconnecting.value = false;
        toast.add({ severity: 'error', summary: 'Timeout', detail: 'Server did not come back within 2 minutes. Check logs.', life: 10000 });
      }
    }
  }, 3000);
}

onMounted(async () => {
  await fetchVersionInfo();
  await fetchUpdateStatus();
  // If there's an active update, start polling
  if (isUpdating.value) {
    startPolling();
  }
});

onUnmounted(() => {
  stopPolling();
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
});
</script>

<style scoped>
.update-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Version row */
.version-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
}
.version-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.version-label {
  font-size: 0.85rem;
  color: var(--text-color-secondary);
}
.version-number {
  font-size: 1.5rem;
  font-weight: 700;
  font-family: var(--font-mono, monospace);
}
.version-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.last-checked {
  font-size: 0.8rem;
  color: var(--text-color-secondary);
}

/* Docker notice */
.docker-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  background: var(--surface-ground);
  border-left: 3px solid var(--blue-500);
}
.docker-notice i {
  font-size: 1.25rem;
  color: var(--blue-500);
  margin-top: 0.1rem;
}
.docker-notice p {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  color: var(--text-color-secondary);
}

/* Update available */
.update-available {
  border-left: 3px solid var(--green-500);
}
.update-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
}
.update-header h3 {
  margin: 0;
}
.update-version {
  font-size: 1.1rem;
  margin: 0.25rem 0 0;
  font-family: var(--font-mono, monospace);
}
.update-version .pi-arrow-right {
  font-size: 0.8rem;
  margin: 0 0.25rem;
  color: var(--text-color-secondary);
}
.update-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.release-link {
  color: var(--primary-color);
  text-decoration: none;
  font-size: 0.9rem;
}
.release-link:hover { text-decoration: underline; }

/* Up to date */
.up-to-date {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--green-500);
  font-weight: 600;
}
.up-to-date .pi-check-circle { font-size: 1.25rem; }

/* Update steps */
.update-steps {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.update-step {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.35rem 0;
}
.step-icon {
  width: 1.5rem;
  height: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.75rem;
  flex-shrink: 0;
}
.update-step.done .step-icon {
  background: var(--green-500);
  color: white;
}
.update-step.active .step-icon {
  background: var(--primary-color);
  color: white;
}
.update-step.pending .step-icon {
  background: var(--surface-200);
}
.step-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--surface-400);
}
.step-label {
  font-size: 0.9rem;
}
.update-step.done .step-label { color: var(--green-500); }
.update-step.active .step-label { font-weight: 600; }
.update-step.pending .step-label { color: var(--text-color-secondary); }

.status-message {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-color-secondary);
}

/* Reconnecting overlay */
.reconnecting-overlay {
  text-align: center;
  padding: 2rem 1rem;
}
.reconnecting-spinner {
  font-size: 2rem;
  color: var(--primary-color);
}
.reconnecting-overlay p {
  margin: 1rem 0 0.25rem;
  font-weight: 600;
}
.reconnecting-overlay small {
  color: var(--text-color-secondary);
}

/* Update results */
.update-result {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-top: 1rem;
  padding: 0.75rem;
  border-radius: var(--border-radius);
}
.update-result.success {
  background: color-mix(in srgb, var(--green-500) 10%, transparent);
  border: 1px solid var(--green-500);
}
.update-result.success > i { color: var(--green-500); font-size: 1.25rem; }
.update-result.error {
  background: color-mix(in srgb, var(--red-500) 10%, transparent);
  border: 1px solid var(--red-500);
}
.update-result.error > i { color: var(--red-500); font-size: 1.25rem; }
.update-result div { flex: 1; }
.update-result p { margin: 0.25rem 0 0; font-size: 0.9rem; }
.rollback-hint { font-size: 0.85rem; color: var(--text-color-secondary); }
.rollback-hint code {
  background: var(--surface-ground);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  font-size: 0.8rem;
}
</style>
