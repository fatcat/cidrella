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

    <div class="header-cards-wrapper">
      <div class="header-cards">
      <div class="dash-card" :class="health?.services?.dnsmasq ? 'card-ok' : 'card-err'" data-track="header-card-dnsmasq">
        <span class="card-dot" :class="health?.services?.dnsmasq ? 'dot-up' : 'dot-down'"></span>
        <div class="card-body">
          <span class="card-value">{{ health?.services?.dnsmasq ? 'Running' : 'Down' }}</span>
          <span class="card-label">DNSmasq</span>
        </div>
      </div>

      <div class="dash-card" :class="cpuStatusClass" data-track="header-card-cpu">
        <span class="card-dot" :class="cpuStatusClass === 'card-err' ? 'dot-down' : cpuStatusClass === 'card-ok' ? 'dot-up' : 'dot-ok'"></span>
        <div class="card-body">
          <span class="card-value">{{ cpuDisplay }}</span>
          <span class="card-label">CPU Load</span>
        </div>
      </div>

      <div class="dash-card" :class="ramStatusClass" data-track="header-card-ram">
        <span class="card-dot" :class="ramStatusClass === 'card-err' ? 'dot-down' : ramStatusClass === 'card-ok' ? 'dot-up' : 'dot-ok'"></span>
        <div class="card-body">
          <span class="card-value">{{ ramDisplay }}</span>
          <span class="card-label">RAM</span>
        </div>
      </div>

      <div class="dash-card" :class="diskStatusClass" data-track="header-card-disk">
        <span class="card-dot" :class="diskStatusClass === 'card-err' ? 'dot-down' : diskStatusClass === 'card-ok' ? 'dot-up' : 'dot-ok'"></span>
        <div class="card-body">
          <span class="card-value">{{ diskDisplay }}</span>
          <span class="card-label">Disk</span>
        </div>
      </div>

      <div class="dash-card" :class="activeScans.length ? 'card-ok' : ''" data-track="header-card-scan"
           :title="!activeScans.length && nextScanFormatted !== '--' ? `Next scan ${nextScanFormatted}` : null">
        <span class="card-dot" :class="activeScans.length ? 'dot-up' : 'dot-ok'"></span>
        <div class="card-body">
          <span class="card-value">{{ scanDisplay }}</span>
          <span class="card-label">{{ scanLabel }}</span>
        </div>
      </div>
      </div>
    </div>

    <!-- Compact health chip — shown below 1280px. Opens a Popover with the 5 stats. -->
    <button class="health-chip-collapsed" data-track="header-card-chip"
            :class="{ 'chip-err': anyServiceDown }"
            @click="toggleHealthChip"
            :title="`Services: ${anyServiceDown ? 'issue' : 'ok'}`">
      <span class="card-dot" :class="anyServiceDown ? 'dot-down' : 'dot-up'"></span>
      <span class="chip-label">Health</span>
    </button>
    <Popover ref="healthChipRef">
      <div class="health-chip-panel">
        <div class="hcp-row">
          <span class="card-dot" :class="health?.services?.dnsmasq ? 'dot-up' : 'dot-down'"></span>
          <span class="hcp-label">DNSmasq</span>
          <span class="hcp-val">{{ health?.services?.dnsmasq ? 'Running' : 'Down' }}</span>
        </div>
        <div class="hcp-row"><span class="card-dot dot-ok"></span><span class="hcp-label">CPU Load</span><span class="hcp-val">{{ cpuDisplay }}</span></div>
        <div class="hcp-row"><span class="card-dot dot-ok"></span><span class="hcp-label">RAM</span><span class="hcp-val">{{ ramDisplay }}</span></div>
        <div class="hcp-row"><span class="card-dot dot-ok"></span><span class="hcp-label">Disk</span><span class="hcp-val">{{ diskDisplay }}</span></div>
        <div class="hcp-row">
          <span class="card-dot" :class="activeScans.length ? 'dot-up' : 'dot-ok'"></span>
          <span class="hcp-label">{{ scanLabel }}</span>
          <span class="hcp-val">{{ scanDisplay }}</span>
        </div>
        <div v-if="!activeScans.length && nextScanFormatted !== '--'" class="hcp-footer">Next scan {{ nextScanFormatted }}</div>
      </div>
    </Popover>

    <div class="header-right">
      <Button icon="pi pi-download" severity="secondary" text rounded size="small"
              title="Import" data-track="header-import" @click="piholeImportRef?.open()" />
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

    <PiholeImport ref="piholeImportRef" @imported="fetchHealth" />

  </header>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Popover from 'primevue/popover';
import Select from 'primevue/select';
import { useAuthStore } from '../stores/auth.js';
import { useSubnetStore } from '../stores/subnets.js';
import { formatScanDate } from '../utils/dateFormat.js';
import PiholeImport from './PiholeImport.vue';
import api from '../api/client.js';

const router = useRouter();
const route = useRoute();

const auth = useAuthStore();
const subnetStore = useSubnetStore();
const piholeImportRef = ref(null);
const userMenuRef = ref(null);
const healthChipRef = ref(null);
const health = ref(null);
const anomalyCount = ref(0);
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

function toggleHealthChip(event) {
  healthChipRef.value?.toggle(event);
}

const userInitials = computed(() => {
  const n = auth.user?.username || '';
  return (n.slice(0, 2) || '—').toUpperCase();
});

const anyServiceDown = computed(() =>
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
  if (!health.value?.cpu) return '--';
  const load1 = health.value.cpu.loadAvg[0];
  const cores = health.value.cpu.cores || 1;
  const pct = Math.round((load1 / cores) * 100);
  return `${pct}%`;
});

const ramDisplay = computed(() => {
  if (!health.value?.memory) return '--';
  const used = formatBytes(health.value.memory.used);
  const total = formatBytes(health.value.memory.total);
  return `${used} / ${total}`;
});

const diskDisplay = computed(() => {
  if (!health.value?.disk) return '--';
  const pct = health.value.disk.percent;
  const used = formatBytes(health.value.disk.used);
  return `${used} (${pct}%)`;
});

const cpuStatusClass = computed(() => {
  const cpu = health.value?.cpu;
  if (!cpu || !cpu.cores) return 'card-ok';
  return cpu.loadAvg[0] > cpu.cores * 2 ? 'card-err' : 'card-ok';
});

const ramStatusClass = computed(() => {
  const mem = health.value?.memory;
  if (!mem || !mem.total) return 'card-ok';
  return (mem.used / mem.total) >= 0.95 ? 'card-err' : 'card-ok';
});

const diskStatusClass = computed(() => {
  const disk = health.value?.disk;
  if (!disk) return 'card-ok';
  return disk.percent >= 90 ? 'card-err' : 'card-ok';
});

const scanDisplay = computed(() => {
  const scans = activeScans.value;
  if (!scans.length) return 'Scanner Idle';

  const running = scans.filter(s => s.status === 'running');
  if (!running.length) return 'Pending';

  const totalIps = running.reduce((sum, s) => sum + (s.total_ips || 0), 0);
  const scannedIps = running.reduce((sum, s) => sum + (s.scanned_ips || 0), 0);
  if (totalIps > 0) return `${Math.round((scannedIps / totalIps) * 100)}%`;
  return 'Running';
});

const scanLabel = computed(() => {
  const n = activeScans.value.length;
  if (!n) return 'Next Scan';
  return n === 1 ? 'Scanning 1 network' : `Scanning ${n} networks`;
});

const nextScanFormatted = computed(() => {
  return formatScanDate(nextScanTime.value) || '--';
});

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
    }
  } catch { /* ignore */ }
}

async function fetchNextScan() {
  try {
    const res = await api.get('/scans/next');
    nextScanTime.value = res.data.next_scan_at || null;
  } catch { /* ignore */ }
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
    anomalyCount.value = res.data.total_active || 0;
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
  fetchActiveScan();
  fetchNextScan();
  fetchUpdateInfo();
  fetchAnomalySummary();
  pollInterval = setInterval(() => { fetchHealth(); fetchActiveScan(); fetchNextScan(); fetchAnomalySummary(); }, 60000);
  window.addEventListener('ipam:stats-changed', fetchHealth);
  window.addEventListener('ipam:scan-started', fetchActiveScan);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
  if (scanPollInterval) clearInterval(scanPollInterval);
  window.removeEventListener('ipam:stats-changed', fetchHealth);
  window.removeEventListener('ipam:scan-started', fetchActiveScan);
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
  flex-shrink: 0;
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

.header-cards-wrapper {
  flex: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  background: transparent;
  padding: 0.4rem;
  max-width: 900px;
  margin-left: auto;
  margin-right: auto;
}
.header-cards {
  display: flex;
  align-items: stretch;
  gap: 0.35rem;
  flex-wrap: nowrap;
  overflow: hidden;
}

.dash-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 90px;
  max-width: 160px;
  padding: 0.3rem 0.55rem;
  background: var(--p-surface-card);
  border-radius: 6px;
  flex-shrink: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.card-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.card-value {
  font-weight: 700;
  font-size: var(--app-fs-md);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-label {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  line-height: 1.2;
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

.dash-card.card-ok { border-left: 3px solid var(--p-primary-color); }
.dash-card.card-err { border-left: 3px solid var(--p-red-500); }
.card-ok .card-value { color: var(--p-primary-color); font-weight: 700; }
.card-err .card-value { color: var(--p-red-500); font-weight: 700; }

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
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

/* ── Collapsed health chip — visible < 1280px only ── */
.health-chip-collapsed {
  display: none;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  height: 28px;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  color: var(--p-text-color);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--app-fs-sm);
  flex-shrink: 0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.health-chip-collapsed:hover {
  background: var(--p-surface-ground);
}
.health-chip-collapsed.chip-err {
  border-left: 3px solid var(--p-red-500);
}
.health-chip-collapsed .chip-label {
  font-size: var(--app-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--p-text-muted-color);
  font-weight: 600;
}

/* ── Health-chip popover panel ── */
.health-chip-panel {
  min-width: 240px;
  padding: 4px;
}
.hcp-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-family: monospace;
  font-size: var(--app-fs-sm);
}
.hcp-row + .hcp-row { border-top: 1px solid color-mix(in srgb, var(--p-surface-border) 60%, transparent); }
.hcp-label {
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: var(--app-fs-xs);
  font-family: inherit;
  font-weight: 600;
}
.hcp-val {
  color: var(--p-text-color);
  font-weight: 600;
}
.hcp-footer {
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
  .header-cards-wrapper { display: none; }
  .health-chip-collapsed { display: inline-flex; }
  .username { display: none; }
  .user-menu-trigger { padding: 0.25rem 0.35rem; gap: 0.3rem; }
}

</style>
