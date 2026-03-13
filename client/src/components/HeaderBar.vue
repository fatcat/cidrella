<template>
  <header class="header-bar">
    <div class="header-left">
      <router-link to="/" class="logo" data-track="header-logo">CIDRella</router-link>
      <span v-if="health?.version" class="version-tag">
        v{{ health.version }}
        <a v-if="updateInfo?.updateAvailable" :href="updateInfo.updateUrl" target="_blank"
           class="update-badge" :title="`Update available: v${updateInfo.updateAvailable}`">
          <i class="pi pi-arrow-up"></i>
        </a>
      </span>
      <nav class="header-nav">
        <router-link to="/dashboard" class="nav-link" :class="{ active: route.path === '/dashboard' }" data-track="nav-dashboard">Dashboard</router-link>
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

      <div class="dash-card" data-track="header-card-networks">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.subnets ?? subnetStore.subnetCount }}</span>
          <span class="card-label">Networks</span>
        </div>
      </div>

      <div class="dash-card" data-track="header-card-dns-zones">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dns_zones ?? '--' }}</span>
          <span class="card-label">DNS Zones</span>
        </div>
      </div>

      <div class="dash-card" data-track="header-card-dhcp-scopes">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dhcp_scopes ?? '--' }}</span>
          <span class="card-label">DHCP Scopes</span>
        </div>
      </div>

      <div class="dash-card" data-track="header-card-leases">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dhcp_leases ?? '--' }}</span>
          <span class="card-label">Leases</span>
        </div>
      </div>

      <div class="dash-card" :class="activeScans.length ? 'card-ok' : ''" data-track="header-card-scan">
        <span class="card-dot" :class="activeScans.length ? 'dot-up' : 'dot-ok'"></span>
        <div class="card-body">
          <span class="card-value">{{ scanDisplay }}</span>
          <span class="card-label">{{ scanLabel }}</span>
          <span v-if="!activeScans.length" class="card-label">{{ nextScanFormatted }}</span>
        </div>
      </div>
      </div>
    </div>

    <div class="header-right">
      <Button icon="pi pi-download" severity="secondary" text rounded size="small"
              title="Import" data-track="header-import" @click="piholeImportRef?.open()" />
      <button class="user-menu-trigger" data-track="header-user-menu" @click="toggleUserMenu">
        <span class="username">{{ auth.user?.username }}</span>
        <span class="role-badge">{{ auth.user?.role }}</span>
        <i class="pi pi-chevron-down user-chevron"></i>
      </button>
      <Popover ref="userMenuRef">
        <div class="user-menu-panel">
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
const health = ref(null);
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
  pollInterval = setInterval(() => { fetchHealth(); fetchActiveScan(); fetchNextScan(); }, 60000);
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
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--p-text-muted-color);
  padding: 0.25rem 0.5rem;
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

.header-cards-wrapper {
  flex: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  background: transparent;
  padding: 0.35rem;
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
  font-size: 0.85rem;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-label {
  font-size: 0.65rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.03em;
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
  gap: 0.35rem;
  font-size: 0.8rem;
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

.role-badge {
  font-size: 0.65rem;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  text-transform: uppercase;
}

.user-chevron {
  font-size: 0.6rem;
  color: var(--p-text-muted-color);
}

.user-menu-panel {
  min-width: 200px;
  padding: 0.5rem;
}

.user-menu-section {
  padding: 0.25rem 0;
}

.user-menu-label {
  display: block;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  margin-bottom: 0.35rem;
  letter-spacing: 0.03em;
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
  font-size: 0.8rem;
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
  font-size: 0.6rem;
  color: var(--p-text-muted-color);
  font-weight: 500;
  opacity: 0.7;
}

.update-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--p-orange-500);
  color: white;
  font-size: 0.55rem;
  text-decoration: none;
  opacity: 1;
  animation: pulse-update 2s ease-in-out infinite;
}
.update-badge:hover {
  background: var(--p-orange-600);
}

@keyframes pulse-update {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--p-orange-500), 0.4); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

</style>
