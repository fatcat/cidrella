<template>
  <header class="header-bar">
    <div class="header-left">
      <router-link to="/" class="logo" data-track="header-logo">CIDRella</router-link>
      <span v-if="health?.version" class="version-tag">
        v{{ health.version }}
        <router-link v-if="updateInfo?.updateAvailable && !updateInfo?.isDocker"
           to="/system?tab=updates"
           class="update-badge" :title="`Update available: v${updateInfo.updateAvailable}`">
          <i class="pi pi-arrow-up"></i>
        </router-link>
      </span>
      <nav class="header-nav">
        <router-link to="/analytics" class="nav-link" :class="{ active: route.path === '/analytics' }" data-track="nav-analytics">
          Analytics
          <span v-if="anomalyCount > 0" class="anomaly-badge">{{ anomalyCount }}</span>
        </router-link>
        <router-link to="/networks" class="nav-link" :class="{ active: route.path === '/networks' || route.path === '/' }" data-track="nav-networks">IP Management</router-link>
        <router-link to="/system" class="nav-link" :class="{ active: route.path === '/system' }" data-track="nav-system">System</router-link>
      </nav>
    </div>

    <div class="header-status">
      <button class="status-chip status-chip-scan" :class="scanChipClass" data-track="header-chip-scan"
              @click="toggleOpsPopover" :title="`Scanner: ${scanDisplay}`">
        <span class="card-dot" :class="activeScans.length ? 'dot-up' : 'dot-ok'"></span>
        <span class="status-chip-label">{{ scanChipText }}</span>
      </button>
      <button class="status-chip status-chip-wide" :class="dnsChipClass" data-track="header-chip-dnsmasq"
              @click="toggleOpsPopover" :title="`DNSmasq: ${dnsDisplay}`">
        <span class="card-dot" :class="health?.services?.dnsmasq ? 'dot-up' : 'dot-down'"></span>
        <span class="status-chip-label">dnsmasq</span>
      </button>
      <button class="status-chip status-chip-wide" :class="cpuChipClass" data-track="header-chip-cpu"
              @click="toggleOpsPopover" :title="`CPU load: ${cpuDisplay}`">
        <span class="card-dot" :class="cpuDotClass"></span>
        <span class="status-chip-label">CPU {{ cpuPercentText }}</span>
      </button>
      <button class="status-chip status-chip-wide" :class="ramChipClass" data-track="header-chip-ram"
              @click="toggleOpsPopover" :title="`RAM: ${ramDisplay}`">
        <span class="card-dot" :class="ramDotClass"></span>
        <span class="status-chip-label">RAM {{ ramPercentText }}</span>
      </button>
      <button class="status-chip status-chip-wide" :class="diskChipClass" data-track="header-chip-disk"
              @click="toggleOpsPopover" :title="`Disk: ${diskDisplay}`">
        <span class="card-dot" :class="diskDotClass"></span>
        <span class="status-chip-label">Disk {{ diskPercentText }}</span>
      </button>
      <button class="status-chip status-chip-ops" :class="{ 'chip-err': opsIssue }"
              data-track="header-chip-ops" @click="toggleOpsPopover"
              :title="`Operations: ${opsIssue ? 'issue' : 'ok'}`">
        <span class="card-dot" :class="opsIssue ? 'dot-down' : 'dot-up'"></span>
        <span class="status-chip-label">Ops</span>
      </button>
      <button class="status-chip status-chip-anomaly" :class="anomalyChipClass"
              data-track="header-chip-anomaly" @click="toggleAnomalyPopover"
              :title="`Anomaly sidecar: ${anomalyStatusLabel}`">
        <span class="card-dot" :class="anomalyDotClass"></span>
        <span class="status-chip-label">Anomaly</span>
        <span v-if="anomalyCount > 0" class="status-chip-badge">{{ anomalyCount }}</span>
      </button>
    </div>

    <Popover ref="opsPopoverRef">
      <div class="status-popover-panel">
        <div class="status-popover-row">
          <span class="card-dot" :class="health?.services?.dnsmasq ? 'dot-up' : 'dot-down'"></span>
          <span class="status-popover-label">DNSmasq</span>
          <span class="status-popover-val">{{ dnsDisplay }}</span>
        </div>
        <div class="status-popover-row">
          <span class="card-dot" :class="cpuDotClass"></span>
          <span class="status-popover-label">CPU Load</span>
          <span class="status-popover-val">{{ cpuDisplay }}</span>
        </div>
        <div class="status-popover-row">
          <span class="card-dot" :class="ramDotClass"></span>
          <span class="status-popover-label">RAM</span>
          <span class="status-popover-val">{{ ramDisplay }}</span>
        </div>
        <div class="status-popover-row">
          <span class="card-dot" :class="diskDotClass"></span>
          <span class="status-popover-label">Disk</span>
          <span class="status-popover-val">{{ diskDisplay }}</span>
        </div>
        <div class="status-popover-row">
          <span class="card-dot" :class="activeScans.length ? 'dot-up' : 'dot-ok'"></span>
          <span class="status-popover-label">Scanner</span>
          <span class="status-popover-val">{{ scanDisplay }}</span>
        </div>
        <div class="status-popover-footer">next scan {{ nextScanTimeOnly }}</div>
      </div>
    </Popover>

    <Popover ref="anomalyPopoverRef">
      <div class="status-popover-panel anomaly-popover-panel">
        <div class="status-popover-row">
          <span class="card-dot" :class="anomalyDotClass"></span>
          <span class="status-popover-label">Sidecar</span>
          <span class="status-popover-val">{{ anomalyStatusLabel }}</span>
        </div>
        <div class="status-popover-row"><span></span><span class="status-popover-label">Active anomalies</span><span class="status-popover-val">{{ anomalyCount }}</span></div>
        <div class="status-popover-row"><span></span><span class="status-popover-label">Clients monitored</span><span class="status-popover-val">{{ anomalySummary?.clients_monitored ?? '—' }}</span></div>
        <div class="status-popover-row"><span></span><span class="status-popover-label">Clients learning</span><span class="status-popover-val">{{ anomalySummary?.clients_learning ?? '—' }}</span></div>
        <div class="status-popover-row"><span></span><span class="status-popover-label">Last scored</span><span class="status-popover-val">{{ timeAgo(anomalySummary?.daemon?.last_score) }}</span></div>
        <div class="status-popover-row"><span></span><span class="status-popover-label">Last trained</span><span class="status-popover-val">{{ timeAgo(anomalySummary?.daemon?.last_train) }}</span></div>
        <div v-if="anomalySummary?.daemon?.score_duration_sec != null" class="status-popover-row">
          <span></span><span class="status-popover-label">Score cycle</span><span class="status-popover-val">{{ anomalySummary.daemon.score_duration_sec }}s</span>
        </div>
        <div v-if="anomalySummary?.daemon?.train_duration_sec != null" class="status-popover-row">
          <span></span><span class="status-popover-label">Train cycle</span><span class="status-popover-val">{{ anomalySummary.daemon.train_duration_sec }}s</span>
        </div>
        <div v-if="anomalySummary?.daemon?.cpu_percent != null" class="status-popover-row">
          <span></span><span class="status-popover-label">Sidecar CPU</span><span class="status-popover-val">{{ Number(anomalySummary.daemon.cpu_percent).toFixed(1) }}%</span>
        </div>
        <div v-if="anomalySummary?.daemon?.rss_mb != null" class="status-popover-row">
          <span></span><span class="status-popover-label">Sidecar RAM</span><span class="status-popover-val">{{ Number(anomalySummary.daemon.rss_mb).toFixed(0) }} MB</span>
        </div>
      </div>
    </Popover>

    <div class="header-right">
      <button class="user-menu-trigger" data-track="header-user-menu" @click="toggleUserMenu">
        <span class="user-avatar">{{ userInitials }}</span>
        <span class="username">{{ auth.user?.username }}</span>
        <i class="pi pi-chevron-down user-chevron"></i>
      </button>
      <Popover ref="userMenuRef">
        <div class="user-menu-panel">
          <div class="user-menu-identity">
            <span class="user-avatar lg">{{ userInitials }}</span>
            <div class="user-menu-id-text">
              <div class="user-menu-name">{{ auth.user?.username }}</div>
              <div v-if="auth.user?.role" class="user-menu-role">{{ auth.user.role }}</div>
            </div>
          </div>
          <div class="user-menu-divider"></div>
          <div class="user-menu-section">
            <label class="user-menu-label">Time Format</label>
            <Select v-model="selectedTimeFormat" :options="timeFormatOptions" optionLabel="label"
                    optionValue="value" data-track="user-pref-time-format" class="w-full"
                    @change="onTimeFormatChange" />
          </div>
          <div class="user-menu-divider"></div>
          <button class="user-menu-item" data-track="header-logout" @click="handleLogout">
            <i class="pi pi-sign-out"></i>
            <span>Sign out</span>
          </button>
        </div>
      </Popover>
    </div>

  </header>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Popover from 'primevue/popover';
import Select from 'primevue/select';
import { useAuthStore } from '../stores/auth.js';
import { useSubnetStore } from '../stores/subnets.js';
import { formatTimeOnly } from '../utils/dateFormat.js';
import api from '../api/client.js';

const router = useRouter();
const route = useRoute();

const auth = useAuthStore();
const subnetStore = useSubnetStore();
const userMenuRef = ref(null);
const opsPopoverRef = ref(null);
const anomalyPopoverRef = ref(null);
const health = ref(null);
const anomalySummary = ref(null);
const activeScans = ref([]);
const nextScanTime = ref(null);
const updateInfo = ref(null);
let pollInterval = null;
let scanPollInterval = null;

const timeFormatOptions = [
  { label: 'Locale Default', value: 'locale' },
  { label: 'AM / PM', value: 'ampm' },
  { label: '24 Hour', value: '24h' }
];

const selectedTimeFormat = ref(auth.timeFormat);
watch(() => auth.timeFormat, (v) => { selectedTimeFormat.value = v; });

function toggleUserMenu(event) {
  userMenuRef.value.toggle(event);
}

function toggleOpsPopover(event) {
  opsPopoverRef.value?.toggle(event);
}

function toggleAnomalyPopover(event) {
  anomalyPopoverRef.value?.toggle(event);
}

const userInitials = computed(() => {
  const n = auth.user?.username || '';
  return (n.slice(0, 2) || '—').toUpperCase();
});

const opsIssue = computed(() =>
  !health.value?.services?.dnsmasq
  || cpuStatusClass.value === 'card-err'
  || ramStatusClass.value === 'card-err'
  || diskStatusClass.value === 'card-err'
);

async function onTimeFormatChange(event) {
  try {
    await auth.updatePreferences({ time_format: event.value });
  } catch { /* ignore */ }
}

function handleLogout() {
  userMenuRef.value.hide();
  auth.logout();
  router.push('/login');
}

function formatBytes(bytes) {
  if (!bytes) return '--';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

const cpuDisplay = computed(() => {
  return `${cpuPercent.value}%`;
});

const cpuPercent = computed(() => {
  if (!health.value?.cpu) return 0;
  const load1 = health.value.cpu.loadAvg[0] || 0;
  const cores = health.value.cpu.cores || 1;
  return Math.round((load1 / cores) * 100);
});

const cpuPercentText = computed(() => `${cpuPercent.value}%`);

const ramDisplay = computed(() => {
  if (!health.value?.memory) return '--';
  const used = formatBytes(health.value.memory.used);
  const total = formatBytes(health.value.memory.total);
  return `${used} / ${total}`;
});

const ramPercent = computed(() => {
  const mem = health.value?.memory;
  if (!mem || !mem.total) return 0;
  return Math.round((mem.used / mem.total) * 100);
});

const ramPercentText = computed(() => `${ramPercent.value}%`);

const diskDisplay = computed(() => {
  if (!health.value?.disk) return '--';
  const pct = health.value.disk.percent;
  const used = formatBytes(health.value.disk.used);
  return `${used} (${pct}%)`;
});

const diskPercentText = computed(() => `${health.value?.disk?.percent ?? 0}%`);

const dnsDisplay = computed(() => health.value?.services?.dnsmasq ? 'Running' : 'Down');

const cpuStatusClass = computed(() => {
  if (cpuPercent.value >= 100) return 'card-err';
  if (cpuPercent.value >= 80) return 'card-warn';
  return 'card-ok';
});

const ramStatusClass = computed(() => {
  if (ramPercent.value >= 95) return 'card-err';
  if (ramPercent.value >= 80) return 'card-warn';
  return 'card-ok';
});

const diskStatusClass = computed(() => {
  const pct = health.value?.disk?.percent ?? 0;
  if (pct >= 90) return 'card-err';
  if (pct >= 80) return 'card-warn';
  return 'card-ok';
});

const scanDisplay = computed(() => {
  const scans = activeScans.value;
  if (!scans.length) return 'scanner idle';

  const running = scans.filter(s => s.status === 'running');
  if (!running.length) return 'Scanner Active';

  const totalIps = running.reduce((sum, s) => sum + (s.total_ips || 0), 0);
  const scannedIps = running.reduce((sum, s) => sum + (s.scanned_ips || 0), 0);
  if (totalIps > 0) return `Scanner Active: ${Math.round((scannedIps / totalIps) * 100)}%`;
  return 'Scanner Active';
});

const scanChipText = computed(() => {
  const scans = activeScans.value;
  if (!scans.length) return 'Scanner idle';
  const running = scans.filter(s => s.status === 'running');
  if (!running.length) return 'Scanner pending';

  const totalIps = running.reduce((sum, s) => sum + (s.total_ips || 0), 0);
  const scannedIps = running.reduce((sum, s) => sum + (s.scanned_ips || 0), 0);
  if (totalIps > 0) return `Scanner active ${Math.round((scannedIps / totalIps) * 100)}%`;
  return 'Scanner active';
});

const scanLabel = computed(() => {
  return `next scan ${nextScanTimeOnly.value}`;
});

const nextScanTimeOnly = computed(() => {
  return formatTimeOnly(nextScanTime.value);
});

const anomalyCount = computed(() => anomalySummary.value?.total_active || 0);

const anomalyStatus = computed(() => {
  const summary = anomalySummary.value;
  if (!summary || !summary.enabled) return 'off';
  if (summary.daemon?.stale) return 'stalled';
  if (summary.daemon) return 'running';
  return 'unknown';
});

const anomalyStatusLabel = computed(() => {
  if (anomalyStatus.value === 'running') return 'Running';
  if (anomalyStatus.value === 'stalled') return 'Stalled';
  if (anomalyStatus.value === 'off') return 'Off';
  return 'Unknown';
});

const anomalyDotClass = computed(() => {
  if (anomalyStatus.value === 'running') return 'dot-up';
  if (anomalyStatus.value === 'off') return 'dot-ok';
  return 'dot-warn';
});

function resourceDot(statusClass) {
  if (statusClass === 'card-err') return 'dot-down';
  if (statusClass === 'card-warn') return 'dot-warn';
  return 'dot-up';
}

function resourceChip(statusClass) {
  if (statusClass === 'card-err') return 'chip-err';
  if (statusClass === 'card-warn') return 'chip-warn';
  return 'chip-ok';
}

const dnsChipClass = computed(() => health.value?.services?.dnsmasq ? 'chip-ok' : 'chip-err');
const cpuChipClass = computed(() => resourceChip(cpuStatusClass.value));
const ramChipClass = computed(() => resourceChip(ramStatusClass.value));
const diskChipClass = computed(() => resourceChip(diskStatusClass.value));
const cpuDotClass = computed(() => resourceDot(cpuStatusClass.value));
const ramDotClass = computed(() => resourceDot(ramStatusClass.value));
const diskDotClass = computed(() => resourceDot(diskStatusClass.value));
const scanChipClass = computed(() => activeScans.value.length ? 'chip-active' : 'chip-idle');
const anomalyChipClass = computed(() => {
  if (anomalyStatus.value === 'running') return 'chip-ok';
  if (anomalyStatus.value === 'off') return 'chip-idle';
  return 'chip-warn';
});

function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function fetchActiveScan() {
  try {
    const res = await api.get('/scans');
    const active = res.data.filter(s => s.status === 'running' || s.status === 'pending');
    activeScans.value = active;

    // Start/stop fast polling based on scan state
    if (active.length && !scanPollInterval) {
      scanPollInterval = setInterval(fetchActiveScan, 2000);
    } else if (!active.length && scanPollInterval) {
      clearInterval(scanPollInterval);
      scanPollInterval = null;
      fetchNextScan();
    }
  } catch { /* ignore */ }
}

async function fetchNextScan() {
  try {
    const res = await api.get('/scans/next');
    nextScanTime.value = res.data.next_scan_at || null;
  } catch { /* ignore */ }
}

function refreshScanHeader() {
  fetchActiveScan();
  fetchNextScan();
}

async function fetchHealth() {
  try {
    const res = await api.get('/health/system');
    health.value = res.data;
  } catch { /* health endpoint may not be available */ }
}

async function fetchAnomalySummary() {
  try {
    const res = await api.get('/anomalies/summary');
    anomalySummary.value = res.data;
  } catch { /* ignore */ }
}

async function fetchUpdateInfo() {
  try {
    const res = await api.get('/version');
    updateInfo.value = res.data;
  } catch { /* ignore */ }
}

onMounted(() => {
  fetchHealth();
  refreshScanHeader();
  fetchUpdateInfo();
  fetchAnomalySummary();
  pollInterval = setInterval(() => { fetchHealth(); refreshScanHeader(); fetchAnomalySummary(); }, 60000);
  window.addEventListener('ipam:stats-changed', fetchHealth);
  window.addEventListener('ipam:scan-started', refreshScanHeader);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
  if (scanPollInterval) clearInterval(scanPollInterval);
  window.removeEventListener('ipam:stats-changed', fetchHealth);
  window.removeEventListener('ipam:scan-started', refreshScanHeader);
});
</script>

<style scoped>
.header-bar {
  display: flex;
  align-items: center;
  padding: 0.5rem 1rem;
  background: var(--p-surface-card);
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
  gap: 1rem;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  flex: 0 0 auto;
}
.logo {
  display: flex;
  align-items: center;
  text-decoration: none;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--p-primary-color);
  letter-spacing: 0.02em;
}

.header-nav {
  display: flex;
  gap: 0.25rem;
  margin-left: 0.5rem;
}
.nav-link {
  text-decoration: none;
  /* +30% over --app-fs-sm (12px) per 2026-04-18 user request for a larger top menubar */
  font-size: calc(var(--app-fs-sm) * 1.3);
  font-weight: 500;
  color: var(--p-text-muted-color);
  padding: 0.3rem 0.6rem;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.nav-link:hover {
  color: var(--p-text-color);
  background: var(--p-surface-ground);
}
.nav-link.active {
  color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  font-weight: 600;
}

.anomaly-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--p-red-500);
  color: white;
  font-size: var(--app-fs-xs);
  font-weight: 700;
  margin-left: 4px;
  line-height: 1;
}

.header-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  flex: 1 1 auto;
  min-width: 0;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  height: 28px;
  padding: 0 0.5rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  color: var(--p-text-color);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--app-fs-sm);
  line-height: 1;
  white-space: nowrap;
  flex: 0 1 auto;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.status-chip:hover {
  background: var(--p-surface-ground);
  border-color: color-mix(in srgb, var(--p-primary-color) 35%, var(--p-surface-border));
}
.status-chip-label {
  font-weight: 700;
  font-size: var(--app-fs-xs);
  letter-spacing: 0.02em;
}

.card-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.card-dot.dot-up { background: var(--p-green-500); }
.card-dot.dot-down { background: var(--p-red-500); }
.card-dot.dot-ok { background: var(--p-surface-400); }
.card-dot.dot-warn { background: var(--p-orange-500); }

.status-chip.chip-ok {
  border-left: 3px solid var(--p-primary-color);
}
.status-chip.chip-active {
  border-left: 3px solid var(--p-green-500);
  color: var(--p-green-600);
}
.status-chip.chip-idle {
  color: var(--p-text-muted-color);
}
.status-chip.chip-warn {
  border-left: 3px solid var(--p-orange-500);
  color: var(--p-orange-600);
}
.status-chip.chip-err {
  border-left: 3px solid var(--p-red-500);
  color: var(--p-red-500);
}
.status-chip-ops {
  display: none;
}
.status-chip-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--p-red-500);
  color: white;
  font-size: var(--app-fs-xs);
  font-weight: 700;
  line-height: 1;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 0 0 auto;
}

.user-menu-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--app-fs-sm);
  margin-left: 0.5rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
  color: var(--p-text-color);
  transition: background 0.15s, border-color 0.15s;
}
.user-menu-trigger:hover {
  background: var(--p-surface-ground);
  border-color: var(--p-surface-border);
}

.username {
  font-weight: 500;
}

.user-avatar {
  display: inline-grid;
  place-items: center;
  width: 24px; height: 24px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
  color: var(--p-primary-color);
  font-size: var(--app-fs-xs);
  font-weight: 700;
  letter-spacing: 0.02em;
  border: 1px solid color-mix(in srgb, var(--p-primary-color) 35%, transparent);
  flex-shrink: 0;
}
.user-avatar.lg {
  width: 36px; height: 36px;
  font-size: var(--app-fs-sm);
}

.user-chevron {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
}

.user-menu-panel {
  min-width: 220px;
  padding: 0.5rem;
}
.user-menu-identity {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.25rem 0.25rem 0.5rem;
}
.user-menu-id-text { min-width: 0; }
.user-menu-name {
  font-size: var(--app-fs-sm);
  font-weight: 600;
  color: var(--p-text-color);
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-menu-role {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 3px;
  font-family: monospace;
}

.user-menu-section {
  padding: 0.25rem 0;
}

.user-menu-label {
  display: block;
  font-size: var(--app-fs-xs);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  margin-bottom: 0.4rem;
  letter-spacing: 0.08em;
}

.user-menu-divider {
  height: 1px;
  background: var(--p-surface-border);
  margin: 0.5rem 0;
}

.user-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: var(--app-fs-sm);
  color: var(--p-text-color);
  transition: background 0.15s;
}
.user-menu-item:hover {
  background: var(--p-surface-ground);
}

.version-tag {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  font-weight: 500;
}

.update-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--p-blue-500);
  color: white;
  font-size: 9px;
  text-decoration: none;
  opacity: 1;
  animation: pulse-update 2s ease-in-out infinite;
}
.update-badge:hover {
  background: var(--p-blue-600);
}

@keyframes pulse-update {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.5); }
  50% { box-shadow: 0 0 0 5px rgba(59, 130, 246, 0); }
}

/* ── Status popover panels ── */
.status-popover-panel {
  min-width: 260px;
  padding: 4px;
}
.anomaly-popover-panel {
  min-width: 300px;
}
.status-popover-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-family: monospace;
  font-size: var(--app-fs-sm);
}
.status-popover-row + .status-popover-row { border-top: 1px solid color-mix(in srgb, var(--p-surface-border) 60%, transparent); }
.status-popover-label {
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: var(--app-fs-xs);
  font-family: inherit;
  font-weight: 600;
}
.status-popover-val {
  color: var(--p-text-color);
  font-weight: 600;
  text-align: right;
}
.status-popover-footer {
  margin-top: 4px;
  padding: 6px 8px;
  border-top: 1px solid var(--p-surface-border);
  font-size: var(--app-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--p-text-muted-color);
  font-family: monospace;
}

/* ── Responsive collapse ── */
@media (max-width: 1279px) {
  .status-chip-wide,
  .status-chip-scan {
    display: none;
  }
  .status-chip-ops {
    display: inline-flex;
  }
}

@media (max-width: 1279px) {
  .username { display: none; }
  .user-menu-trigger { padding: 0.25rem 0.35rem; gap: 0.3rem; }
}

@media (max-width: 960px) {
  .nav-link {
    padding-left: 0.45rem;
    padding-right: 0.45rem;
  }
  .header-status {
    gap: 0.2rem;
  }
  .status-chip {
    padding: 0 0.42rem;
  }
}

</style>
