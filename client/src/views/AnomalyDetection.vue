<template>
  <div class="anomaly-settings-page">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="store.summary">
      <div class="stat">
        <span class="stat-value">
          <span :class="statusIndicatorClass"></span>
          {{ statusLabel }}
        </span>
        <span class="stat-label">Status</span>
        <span v-if="statusSubLabel" class="stat-sublabel">{{ statusSubLabel }}</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ store.summary.clients_monitored }}</span>
        <span class="stat-label">Clients Monitored</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ store.summary.clients_learning }}</span>
        <span class="stat-label">Clients Learning</span>
      </div>
      <div class="stat">
        <span class="stat-value" :class="{ 'text-danger': store.summary.total_active > 0 }">
          {{ store.summary.total_active }}
        </span>
        <span class="stat-label">Active Anomalies</span>
      </div>
    </div>

    <!-- Settings -->
    <div class="settings-grid">
      <div class="setting-field">
        <label class="setting-field-label">Enabled</label>
        <ToggleSwitch v-model="form.enabled" data-track="sys-anomaly-toggle" />
      </div>
      <div class="setting-field">
        <label class="setting-field-label">Sensitivity</label>
        <Select v-model="form.sensitivity" :options="sensitivityOptions" optionLabel="label"
                optionValue="value" size="small" fluid
                data-track="sys-anomaly-sensitivity" />
      </div>
      <div class="setting-field">
        <label class="setting-field-label">Scoring Interval (min)</label>
        <InputNumber v-model="form.scoringInterval" :min="5" :max="120" fluid
                     style="max-width: 10rem" data-track="sys-anomaly-scoring-interval" />
      </div>
      <div class="setting-field">
        <label class="setting-field-label">Training Interval (hr)</label>
        <InputNumber v-model="form.trainingInterval" :min="1" :max="48" fluid
                     style="max-width: 10rem" data-track="sys-anomaly-training-interval" />
      </div>
      <div class="setting-field">
        <label class="setting-field-label">Min Training Hours</label>
        <InputNumber v-model="form.minTrainingHours" :min="12" :max="168" fluid
                     style="max-width: 10rem" data-track="sys-anomaly-min-training" />
      </div>
      <div class="setting-field">
        <label class="setting-field-label">Retention (days)</label>
        <InputNumber v-model="form.retentionDays" :min="1" :max="365" fluid
                     style="max-width: 10rem" data-track="sys-anomaly-retention" />
      </div>
      <div class="setting-field setting-field-action">
        <Button label="Save Settings" icon="pi pi-save" size="small"
                @click="saveSettings" :loading="saving" :disabled="!isDirty"
                data-track="sys-anomaly-save" />
      </div>
    </div>

    <!-- Info -->
    <div class="info-section">
      <h3>How It Works</h3>
      <p>
        Anomaly detection uses machine learning (Isolation Forest) to build behavioral baselines
        for each DNS client on your network. After a training period, it flags clients whose
        query patterns deviate significantly from their established baseline.
      </p>
      <p>
        It can detect behavior such as sudden query-volume spikes, unusually bursty DNS traffic,
        high NXDOMAIN or blocked-query rates, high-entropy or very long domain names, unusual
        query types, unexpected TLD diversity, and clients resolving domains or IPs that differ
        from their normal activity.
      </p>
      <ul>
        <li><strong>Training</strong>: the system needs at least <em>{{ form.minTrainingHours }} hours</em> of DNS query data per client before it can start detecting anomalies.</li>
        <li><strong>Scoring</strong>: every <em>{{ form.scoringInterval }} minutes</em>, the system evaluates the last hour of queries for each trained client.</li>
        <li><strong>Sensitivity</strong>: controls how aggressively the system flags anomalies. Higher sensitivity means more alerts.</li>
        <li><strong>Auto-resolve</strong>: anomalies are automatically resolved after 4 consecutive normal scoring windows.</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { EMPTY_CELL } from '../utils/format.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import Select from '../ui/Select.js';
import InputNumber from '../ui/InputNumber.js';
import Button from '../ui/Button.js';
import { useAnomalyStore } from '../stores/anomalies.js';

const store = useAnomalyStore();
const saving = ref(false);

const sensitivityOptions = [
  { label: 'Low (fewer alerts)', value: 'low' },
  { label: 'Medium (balanced)', value: 'medium' },
  { label: 'High (more alerts)', value: 'high' },
];

const form = reactive({
  enabled: false,
  sensitivity: 'medium',
  scoringInterval: 15,
  trainingInterval: 6,
  minTrainingHours: 48,
  retentionDays: 30,
});

// Track original values for dirty detection
const original = reactive({ ...form });

// Status indicator resolves the combined state of the user-toggled setting
// AND the daemon's actual liveness. Prior to v0.4.5 this was just
// `summary.enabled`, which lied green when the daemon was dead. The server
// now includes `daemon.stale` when heartbeats have gone silent past the
// expected interval, and we surface that as a warning state distinct from
// "disabled".
const statusIndicatorClass = computed(() => {
  const s = store.summary;
  if (!s || !s.enabled) return 'indicator-off';
  if (s.daemon && s.daemon.stale) return 'indicator-warn';
  if (s.daemon && !s.daemon.stale) return 'indicator-on';
  return 'indicator-warn';
});

const statusLabel = computed(() => {
  const s = store.summary;
  if (!s) return EMPTY_CELL;
  if (!s.enabled) return 'Disabled';
  if (s.daemon && s.daemon.stale) return 'Stalled';
  if (s.daemon) return 'Running';
  return 'Unknown';
});

const statusSubLabel = computed(() => {
  const s = store.summary;
  if (!s || !s.enabled) return null;
  if (s.daemon && s.daemon.stale) {
    if (s.daemon.stale_reason === 'no_heartbeat') return 'no heartbeat recorded';
    const age = s.daemon.heartbeat_age_sec;
    if (Number.isFinite(age)) {
      if (age < 120) return `last heartbeat ${age}s ago`;
      if (age < 7200) return `last heartbeat ${Math.round(age / 60)}min ago`;
      return `last heartbeat ${Math.round(age / 3600)}h ago`;
    }
    return 'heartbeat too old';
  }
  return null;
});

const isDirty = computed(() => {
  return form.enabled !== original.enabled
    || form.sensitivity !== original.sensitivity
    || form.scoringInterval !== original.scoringInterval
    || form.trainingInterval !== original.trainingInterval
    || form.minTrainingHours !== original.minTrainingHours
    || form.retentionDays !== original.retentionDays;
});

function loadFromSettings() {
  if (!store.settings) return;
  form.enabled = store.settings.anomaly_detection_enabled === 'true';
  form.sensitivity = store.settings.anomaly_sensitivity || 'medium';
  form.scoringInterval = parseInt(store.settings.anomaly_scoring_interval_min, 10) || 15;
  form.trainingInterval = parseInt(store.settings.anomaly_training_interval_hours, 10) || 6;
  form.minTrainingHours = parseInt(store.settings.anomaly_min_training_hours, 10) || 48;
  form.retentionDays = parseInt(store.settings.anomaly_retention_days, 10) || 30;
  Object.assign(original, { ...form });
}

async function saveSettings() {
  saving.value = true;
  try {
    await store.updateSettings({
      anomaly_detection_enabled: form.enabled ? 'true' : 'false',
      anomaly_sensitivity: form.sensitivity,
      anomaly_scoring_interval_min: String(form.scoringInterval),
      anomaly_training_interval_hours: String(form.trainingInterval),
      anomaly_min_training_hours: String(form.minTrainingHours),
      anomaly_retention_days: String(form.retentionDays),
    });
    Object.assign(original, { ...form });
    await store.fetchSummary();
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    store.fetchSettings(),
    store.fetchSummary(),
  ]);
  loadFromSettings();
});

watch(() => store.settings, loadFromSettings);
</script>

<style>
@import '../assets/analytics-layout.css';
</style>

<style scoped>
.anomaly-settings-page {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}






.settings-grid {
  display: grid;
  grid-template-columns: auto repeat(6, auto);
  gap: 1rem;
  align-items: end;
  padding: 0.75rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.setting-field-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.setting-field-action {
  justify-content: flex-end;
}

.info-section {
  padding: 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}

.info-section h3 {
  font-size: 0.9rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
}

.info-section p {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
  line-height: 1.5;
}

.info-section ul {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
  padding-left: 1.25rem;
  line-height: 1.8;
}

</style>
