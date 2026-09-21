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
          <Button
            label="Check Now"
            icon="pi pi-refresh"
            size="small"
            text
            data-track="update-check-now"
            :loading="checking"
            @click="checkForUpdate"
          />
          <!-- Always-visible recovery affordance. Defense-in-depth for the
               class of bug where the update-status record gets stuck in a
               non-idle state and the normal Dismiss button (scoped to the
               progress card, which only renders for completed/failed) is
               not reachable. Clicking this is equivalent to the server
               rm'ing /var/lib/cidrella/update-status.json. Safe at any
               time; worst case it clears an active update's progress UI,
               not the underlying update process. -->
          <Button
            icon="pi pi-ellipsis-v"
            size="small"
            text
            title="Reset update state"
            aria-label="Reset update state"
            data-track="update-reset-state"
            @click="showResetConfirm = true"
          />
        </div>
      </div>
    </div>

    <!-- Docker Notice -->
    <div v-if="versionInfo?.isDocker" class="content-card docker-notice">
      <i class="pi pi-info-circle"></i>
      <div>
        <strong>Docker deployment detected</strong>
        <p>
          In-app updates are not available for Docker deployments. Pull the latest image to update.
        </p>
      </div>
    </div>

    <!-- Available Update -->
    <div
      v-else-if="versionInfo?.updateAvailable && !isUpdating && updateStatus?.state !== 'completed'"
      class="content-card update-available"
    >
      <div class="update-header">
        <div>
          <h3>Update Available</h3>
          <p class="update-version">
            v{{ versionInfo.version }} <i class="pi pi-arrow-right"></i> v{{
              versionInfo.updateAvailable
            }}
          </p>
          <!-- Multi-hop skip-upgrade context: explain why this is step N of M
               and what the ultimate destination is. Read-only, no auto-chain
               in v0.4.12. User clicks Install once per hop; after each
               successful completion + restart, this card will re-render with
               the next hop as the new "updateAvailable". -->
          <div v-if="isMultiHopChain" class="chain-info">
            <p class="chain-summary">
              <i class="pi pi-info-circle"></i>
              <span>
                Step <strong>1 of {{ versionInfo.updateChain.length }}</strong
                >: the latest version <strong>v{{ versionInfo.chainTarget }}</strong> requires going
                through intermediate versions first.
              </span>
            </p>
            <p class="chain-steps">
              <span class="chain-path">
                <span>v{{ versionInfo.version }}</span>
                <template v-for="(hop, idx) in versionInfo.updateChain" :key="hop">
                  <i class="pi pi-arrow-right"></i>
                  <span
                    :class="{
                      'chain-current-hop': idx === 0,
                      'chain-final-hop': idx === versionInfo.updateChain.length - 1,
                    }"
                  >
                    v{{ hop }}
                  </span>
                </template>
              </span>
            </p>
            <p class="chain-hint">
              After this update completes, return to this panel and click <strong>Install</strong>
              again to continue the chain.
            </p>
          </div>
          <!-- Manifest degraded: surface the fact that skip-upgrade info is
               unavailable so the user knows a direct jump may not be the whole
               story. Silent degradation was an explicit anti-goal for this phase. -->
          <p v-if="versionInfo.manifestAvailable === false" class="manifest-fallback-note">
            <i class="pi pi-exclamation-triangle"></i>
            Skip-upgrade information unavailable (release manifest unreachable). Additional updates
            may be required after this one.
          </p>
        </div>
        <div class="update-actions">
          <a
            v-if="versionInfo.updateUrl"
            :href="versionInfo.updateUrl"
            target="_blank"
            class="release-link"
            data-track="update-release-notes"
          >
            <i class="pi pi-external-link"></i> Release Notes
          </a>
          <Button
            :label="isMultiHopChain ? 'Install Step 1' : 'Install Update'"
            icon="pi pi-download"
            severity="success"
            data-track="update-install"
            :loading="installing"
            @click="confirmInstall"
          />
        </div>
      </div>
    </div>

    <!-- Up to Date -->
    <div
      v-else-if="
        !versionInfo?.updateAvailable && !isUpdating && updateStatus?.state !== 'completed'
      "
      class="content-card up-to-date"
    >
      <i class="pi pi-check-circle"></i>
      <span>CIDRella is up to date</span>
    </div>

    <!-- Update Progress -->
    <div
      v-if="isUpdating || updateStatus?.state === 'completed' || updateStatus?.state === 'failed'"
      class="content-card update-progress"
    >
      <h3>Update Progress</h3>

      <!-- Step indicator. The steps follow the phases update.sh writes to the
           status file; the message under the active step is the script's own. -->
      <div class="update-steps">
        <div
          v-for="(step, i) in updateSteps"
          :key="step.key"
          class="update-step"
          :class="stepClass(i)"
          :data-step-state="stepClass(i)"
        >
          <div class="step-icon">
            <i v-if="stepClass(i) === 'done'" class="pi pi-check"></i>
            <i v-else-if="stepClass(i) === 'active'" class="pi pi-spin pi-spinner"></i>
            <i v-else-if="stepClass(i) === 'failed'" class="pi pi-times"></i>
            <span v-else class="step-dot"></span>
          </div>
          <div class="step-text">
            <span class="step-label">{{ step.label }}</span>
            <small v-if="stepClass(i) === 'active' && stepMessage" class="step-message">
              {{ stepMessage }}
            </small>
          </div>
        </div>
      </div>

      <!-- Progress Bar -->
      <ProgressBar
        v-if="isUpdating || reconnecting"
        :value="reconnecting ? 90 : updateStatus?.progress_pct || 0"
        :showValue="true"
        style="margin-top: 1rem"
      />

      <!-- Completed -->
      <div v-if="updateStatus?.state === 'completed'" class="update-result success">
        <i class="pi pi-check-circle"></i>
        <div>
          <strong>Update complete</strong>
          <p>Updated from v{{ updateStatus.from_version }} to v{{ updateStatus.to_version }}</p>
          <p v-if="reloadCountdown !== null" class="reload-note">
            Reloading in {{ reloadCountdown }}s to pick up the new interface.
          </p>
        </div>
        <Button
          v-if="reloadCountdown !== null"
          label="Reload now"
          icon="pi pi-refresh"
          size="small"
          data-track="update-reload-now"
          @click="reloadPage"
        />
        <Button
          v-else
          label="Dismiss"
          icon="pi pi-times"
          size="small"
          text
          data-track="update-dismiss"
          @click="dismissStatus"
        />
      </div>

      <!-- Failed -->
      <div v-if="updateStatus?.state === 'failed'" class="update-result error">
        <i class="pi pi-times-circle"></i>
        <div>
          <strong>Update failed</strong>
          <pre class="error-detail">{{ updateStatus.error || 'An unknown error occurred.' }}</pre>
          <p v-if="updateStatus.backup_path" class="rollback-hint">
            Rollback available at: <code>{{ updateStatus.backup_path }}</code>
          </p>
          <p
            v-if="updateStatus.reason_code === 'ip_lifecycle_migration_blocked'"
            class="rollback-hint"
          >
            CIDRella found IP allocation conflicts that require an administrator's decision.
            Download the report, resolve every listed conflict, then run the update again.
          </p>
        </div>
        <div class="result-actions">
          <Button
            v-if="
              updateStatus.reason_code === 'ip_lifecycle_migration_blocked' &&
              updateStatus.lifecycle_migration_report_available
            "
            label="Download reconciliation report"
            icon="pi pi-download"
            size="small"
            severity="secondary"
            data-track="update-download-lifecycle-report"
            @click="downloadLifecycleReport"
          />
          <Button
            label="Dismiss"
            icon="pi pi-times"
            size="small"
            text
            data-track="update-dismiss-error"
            @click="dismissStatus"
          />
        </div>
      </div>
    </div>

    <div
      v-if="updateStatus?.lifecycle_migration_report_available && updateStatus?.state !== 'failed'"
      class="content-card report-available"
    >
      <i class="pi pi-file"></i>
      <div>
        <strong>IP lifecycle migration report available</strong>
        <p>The report contains the migration outcome and any reconciliation details.</p>
      </div>
      <Button
        label="Download reconciliation report"
        icon="pi pi-download"
        size="small"
        severity="secondary"
        data-track="update-download-lifecycle-report-available"
        @click="downloadLifecycleReport"
      />
    </div>

    <!-- Settings -->
    <div class="content-card settings-form">
      <h3>Settings</h3>
      <div class="field field-inline">
        <label>Check for updates automatically</label>
        <ToggleSwitch
          v-model="updateCheckEnabled"
          data-track="update-check-toggle"
          @update:modelValue="saveSettings"
        />
      </div>
    </div>

    <!-- Confirmation Dialog -->
    <Dialog
      v-model:visible="showConfirmDialog"
      :header="
        isMultiHopChain ? 'Install Step 1 of ' + versionInfo.updateChain.length : 'Install Update'
      "
      :modal="true"
      :closable="true"
      :style="{ width: '32rem' }"
    >
      <p>
        This will update CIDRella from <strong>v{{ versionInfo?.version }}</strong> to
        <strong>v{{ versionInfo?.updateAvailable }}</strong
        >.
      </p>
      <div v-if="isMultiHopChain" class="chain-confirm-note">
        <p>
          The latest version <strong>v{{ versionInfo.chainTarget }}</strong> requires upgrading
          through {{ versionInfo.updateChain.length }} intermediate versions due to version
          compatibility rules. After this step completes, return to the Updates panel and click
          <strong>Install</strong> again to continue toward v{{ versionInfo.chainTarget }}.
        </p>
        <p class="chain-confirm-steps">
          Full path:
          <span>v{{ versionInfo.version }}</span>
          <template v-for="hop in versionInfo.updateChain" :key="hop">
            <i class="pi pi-arrow-right"></i><span>v{{ hop }}</span>
          </template>
        </p>
      </div>
      <p>The server will restart during the update. You may briefly lose connectivity.</p>
      <template #footer>
        <Button label="Cancel" text @click="showConfirmDialog = false" />
        <Button
          :label="isMultiHopChain ? 'Install Step 1' : 'Install'"
          icon="pi pi-download"
          severity="success"
          data-track="update-confirm-install"
          @click="startInstall"
        />
      </template>
    </Dialog>

    <!-- Reset-update-state Confirmation -->
    <ConfirmDialog
      v-model:visible="showResetConfirm"
      header="Reset update state"
      width="28rem"
      severity="warn"
      confirm-label="Reset state"
      confirm-icon="pi pi-refresh"
      data-track="dialog-update-reset-state"
      confirm-track="update-reset-state-confirm"
      @confirm="resetUpdateState"
    >
      <p>
        This clears the in-progress update status record on the server. Use this only if the update
        panel appears stuck and you can't otherwise dismiss it.
      </p>
      <p>
        It does <strong>not</strong> affect the actual cidrella service, the installed version, or
        any update process that may still be running in the background.
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiError } from '../utils/format.js';
import Button from '../ui/Button.js';
import ProgressBar from '../ui/ProgressBar.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import Dialog from '../ui/Dialog.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { useToast } from '../ui/useToast.js';
import api from '../api/client.js';
import { formatRelativeTime as formatRelative } from '../utils/dateFormat.js';

const toast = useToast();

const versionInfo = ref(null);
const updateStatus = ref(null);
const checking = ref(false);
const installing = ref(false);
const reconnecting = ref(false);
const showConfirmDialog = ref(false);
const showResetConfirm = ref(false);
const updateCheckEnabled = ref(true);

let pollTimer = null;
let reconnectTimer = null;
let reloadTimer = null;

// Seconds left before the page reloads itself after a completed update, or
// null when no reload is scheduled. The browser is still running the bundle
// from the previous version, and its asset names are gone after the swap, so
// the reload is not optional. It is only scheduled for an update this page
// watched happen, never for a completed status found on a later visit.
const reloadCountdown = ref(null);
const RELOAD_DELAY_S = 5;
let watchedInstall = false;

// One entry per phase of update.sh, in the order the script runs them. `states`
// are the names the script writes; `from` is the progress_pct the phase starts
// at, the fallback when the status carries a state name this build does not
// know (the script and the panel come from the same release, but the failed
// record only carries the percentage of the phase that failed).
const updateSteps = [
  {
    key: 'download',
    label: 'Downloading release',
    states: ['starting', 'preflight', 'downloading'],
    from: 0,
  },
  { key: 'verify', label: 'Verifying signature', states: ['verifying'], from: 30 },
  { key: 'extract', label: 'Extracting files', states: ['extracting'], from: 40 },
  { key: 'validate', label: 'Validating new version', states: ['validating'], from: 55 },
  { key: 'snapshot', label: 'Snapshotting databases', states: ['snapshotting'], from: 75 },
  { key: 'switch', label: 'Switching over', states: ['switching', 'restarting'], from: 85 },
  { key: 'confirm', label: 'Confirming health', states: ['confirming'], from: 93 },
];
const SWITCH_STEP = updateSteps.findIndex((s) => s.key === 'switch');

const isUpdating = computed(() => {
  const s = updateStatus.value?.state;
  return s && s !== 'idle' && s !== 'completed' && s !== 'failed';
});

// Index of the step the update is in. Everything before it is done. Equals
// updateSteps.length once the update completed. While the server is down for
// the restart there is no status to read, so the switch step stays active.
const activeStep = computed(() => {
  if (reconnecting.value) return SWITCH_STEP;
  const status = updateStatus.value;
  if (!status || status.state === 'idle') return -1;
  if (status.state === 'completed') return updateSteps.length;
  const byState = updateSteps.findIndex((s) => s.states.includes(status.state));
  if (byState >= 0) return byState;
  const pct = Number(status.progress_pct) || 0;
  let idx = 0;
  updateSteps.forEach((s, i) => {
    if (pct >= s.from) idx = i;
  });
  return idx;
});

const stepMessage = computed(() => {
  if (reconnecting.value) return 'CIDRella is restarting with the new version...';
  return updateStatus.value?.message || '';
});

// True when the available update is part of a multi-hop skip-upgrade
// chain. When false, `updateAvailable` and `chainTarget` are the same
// version and the standard single-hop flow applies. When true, the user
// is looking at step 1 of the chain and must click Install, wait for it
// to complete, return to this panel, and click again for each subsequent
// step. No automatic continuation, that was explicitly cut from v0.4.12
// per the pre-implementation agent review.
const isMultiHopChain = computed(() => {
  const chain = versionInfo.value?.updateChain;
  return Array.isArray(chain) && chain.length > 1;
});

function stepClass(i) {
  if (i < activeStep.value) return 'done';
  if (i === activeStep.value) return updateStatus.value?.state === 'failed' ? 'failed' : 'active';
  return 'pending';
}

async function fetchVersionInfo() {
  try {
    const res = await api.get('/version');
    versionInfo.value = res.data;
    updateCheckEnabled.value = res.data.updateCheckEnabled;
  } catch {
    /* ignore */
  }
}

async function fetchUpdateStatus() {
  try {
    const res = await api.get('/version/update-status');
    updateStatus.value = res.data;
    const state = res.data.state;
    if (state === 'completed' || state === 'failed') {
      stopPolling();
      if (state === 'completed' && watchedInstall) scheduleReload();
    } else if (isUpdating.value) {
      watchedInstall = true;
    }
  } catch {
    // API unreachable. If we were updating, we're in the restart phase
    if (isUpdating.value) {
      startReconnecting();
    }
  }
}

function scheduleReload() {
  if (reloadTimer) return;
  reloadCountdown.value = RELOAD_DELAY_S;
  reloadTimer = setInterval(() => {
    reloadCountdown.value -= 1;
    if (reloadCountdown.value <= 0) reloadPage();
  }, 1000);
}

function reloadPage() {
  if (reloadTimer) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }
  window.location.reload();
}

async function checkForUpdate() {
  checking.value = true;
  try {
    const res = await api.post('/version/check');
    versionInfo.value = { ...versionInfo.value, ...res.data };
    if (res.data.updateAvailable) {
      toast.add({
        severity: 'info',
        summary: 'Update available',
        detail: `v${res.data.updateAvailable}`,
        life: 4000,
      });
    } else {
      toast.add({
        severity: 'info',
        summary: 'Up to date',
        detail: 'No updates available',
        life: 3000,
      });
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Check failed', detail: apiError(err), life: 4000 });
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
    watchedInstall = true;
    toast.add({
      severity: 'info',
      summary: 'Update started',
      detail: 'Installing update...',
      life: 3000,
    });
    startPolling();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: apiError(err), life: 5000 });
  } finally {
    installing.value = false;
  }
}

async function dismissStatus() {
  try {
    await api.post('/version/update-dismiss');
    updateStatus.value = { state: 'idle' };
    await fetchVersionInfo();
  } catch {
    /* ignore */
  }
}

async function downloadLifecycleReport() {
  try {
    const endpoint =
      updateStatus.value?.lifecycle_migration_report_download ||
      '/version/ip-lifecycle-migration-report';
    const res = await api.get(endpoint.replace(/^\/api/, ''), { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ip-lifecycle-migration-report.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Download failed',
      detail: apiError(err),
      life: 5000,
    });
  }
}

// Header-level defense-in-depth: always reachable even when state is stuck
// in a non-idle phase that would normally hide the Dismiss button. Wraps
// the same /version/update-dismiss endpoint as dismissStatus() but is
// callable from the Version card header regardless of updateStatus shape.
async function resetUpdateState() {
  showResetConfirm.value = false;
  try {
    await api.post('/version/update-dismiss');
    updateStatus.value = { state: 'idle' };
    stopPolling();
    await fetchVersionInfo();
    toast.add({ severity: 'success', summary: 'Update state cleared', life: 2500 });
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not clear update state',
      detail: apiError(err),
      life: 4000,
    });
  }
}

async function saveSettings() {
  try {
    await api.put('/settings', {
      update_check_enabled: updateCheckEnabled.value ? 'true' : 'false',
    });
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
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
      // Server is back, fetch final state
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      reconnecting.value = false;
      await fetchVersionInfo();
      await fetchUpdateStatus();
      // The script is still confirming health after the restart, so keep
      // watching until it writes completed or failed.
      if (isUpdating.value) startPolling();
    } catch {
      if (Date.now() - startTime > maxWait) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        reconnecting.value = false;
        toast.add({
          severity: 'error',
          summary: 'Timeout',
          detail: 'Server did not come back within 2 minutes. Check logs.',
          life: 10000,
        });
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
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  if (reloadTimer) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }
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
.release-link:hover {
  text-decoration: underline;
}

/* Multi-hop skip-upgrade chain display */
.chain-info {
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--surface-100);
  border-left: 3px solid var(--primary-color);
  border-radius: 0 4px 4px 0;
  font-size: 0.9rem;
}
.chain-summary {
  margin: 0 0 0.5rem 0;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.chain-summary .pi-info-circle {
  color: var(--primary-color);
  margin-top: 0.15rem;
  flex-shrink: 0;
}
.chain-steps {
  margin: 0.5rem 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.85rem;
}
.chain-path {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.chain-path .pi-arrow-right {
  font-size: 0.7rem;
  color: var(--text-color-secondary);
}
.chain-current-hop {
  color: var(--green-500);
  font-weight: 600;
}
.chain-final-hop {
  color: var(--primary-color);
  font-weight: 600;
}
.chain-hint {
  margin: 0.5rem 0 0 0;
  color: var(--text-color-secondary);
  font-size: 0.85rem;
}
.chain-confirm-note {
  background: var(--surface-100);
  border-left: 3px solid var(--primary-color);
  padding: 0.75rem 1rem;
  border-radius: 0 4px 4px 0;
  margin: 0.75rem 0;
  font-size: 0.9rem;
}
.chain-confirm-steps {
  font-family: var(--font-mono, monospace);
  font-size: 0.85rem;
  margin: 0.5rem 0 0 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.chain-confirm-steps .pi-arrow-right {
  font-size: 0.7rem;
  color: var(--text-color-secondary);
}
.manifest-fallback-note {
  margin: 0.75rem 0 0 0;
  padding: 0.5rem 0.75rem;
  background: var(--yellow-50, #fef3c7);
  color: var(--yellow-900, #78350f);
  border-left: 3px solid var(--yellow-500, #f59e0b);
  border-radius: 0 4px 4px 0;
  font-size: 0.85rem;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.manifest-fallback-note .pi-exclamation-triangle {
  margin-top: 0.15rem;
  flex-shrink: 0;
}

/* Up to date */
.up-to-date {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--green-500);
  font-weight: 600;
}
.up-to-date .pi-check-circle {
  font-size: 1.25rem;
}

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
.update-step.failed .step-icon {
  background: var(--red-500);
  color: white;
}
.step-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.step-message {
  font-size: 0.8rem;
  color: var(--text-color-secondary);
}
.reload-note {
  margin-top: 0.25rem;
  font-size: 0.85rem;
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
.update-step.done .step-label {
  color: var(--green-500);
}
.update-step.active .step-label {
  font-weight: 600;
}
.update-step.pending .step-label {
  color: var(--text-color-secondary);
}
.update-step.failed .step-label {
  color: var(--red-500);
  font-weight: 600;
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
.update-result.success > i {
  color: var(--green-500);
  font-size: 1.25rem;
}
.update-result.error {
  background: color-mix(in srgb, var(--red-500) 10%, transparent);
  border: 1px solid var(--red-500);
}
.update-result.error > i {
  color: var(--red-500);
  font-size: 1.25rem;
}
.update-result div {
  flex: 1;
}
.update-result p {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
}
.error-detail {
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255, 0, 0, 0.08);
  border-left: 3px solid var(--red-500);
  border-radius: 3px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 20rem;
  overflow-y: auto;
}
.rollback-hint {
  font-size: 0.85rem;
  color: var(--text-color-secondary);
}
.rollback-hint code {
  background: var(--surface-ground);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  font-size: 0.8rem;
}
.report-available {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.report-available > i {
  color: var(--primary-color);
  font-size: 1.25rem;
}
.report-available > div {
  flex: 1;
}
.report-available p {
  margin: 0.25rem 0 0;
  color: var(--text-color-secondary);
  font-size: 0.9rem;
}
.update-result .result-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
