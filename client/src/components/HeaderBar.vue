<template>
  <header class="header-bar">
    <div class="header-left">
      <router-link to="/" class="logo" data-track="header-logo"><img src="/logo.png" alt="CIDRella" class="logo-img" /></router-link>
    </div>

    <div class="header-cards-wrapper">
      <div class="header-cards">
      <div class="dash-card" :class="health?.services?.dnsmasq ? 'card-ok' : 'card-err'" data-track="header-card-dnsmasq">
        <div class="card-body">
          <span class="card-value">{{ health?.services?.dnsmasq ? 'Running' : 'Down' }}</span>
          <span class="card-label">DNSmasq</span>
        </div>
      </div>

      <div class="dash-card" :class="cpuStatusClass" data-track="header-card-cpu">
        <div class="card-body">
          <span class="card-value">{{ cpuDisplay }}</span>
          <span class="card-label">CPU Load</span>
        </div>
      </div>

      <div class="dash-card" :class="ramStatusClass" data-track="header-card-ram">
        <div class="card-body">
          <span class="card-value">{{ ramDisplay }}</span>
          <span class="card-label">RAM</span>
        </div>
      </div>

      <div class="dash-card" :class="diskStatusClass" data-track="header-card-disk">
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

      <div class="dash-card" :class="activeScan ? 'card-ok' : ''" data-track="header-card-scan">
        <div class="card-body">
          <span class="card-value">{{ scanDisplay }}</span>
          <span class="card-label">Scan</span>
        </div>
      </div>
      </div>
    </div>

    <div class="header-right">
      <Button icon="pi pi-download" severity="secondary" text rounded size="small"
              title="Import" data-track="header-import" @click="piholeImportRef?.open()" />
      <div class="user-info">
        <span class="username">{{ auth.user?.username }}</span>
        <span class="role-badge">{{ auth.user?.role }}</span>
      </div>
      <Button icon="pi pi-sign-out" severity="secondary" text rounded size="small"
              title="Sign out" data-track="header-logout" @click="handleLogout" />
    </div>

    <PiholeImport ref="piholeImportRef" @imported="fetchHealth" />

  </header>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useAuthStore } from '../stores/auth.js';
import { useSubnetStore } from '../stores/subnets.js';
import PiholeImport from './PiholeImport.vue';
import api from '../api/client.js';

const router = useRouter();

const auth = useAuthStore();
const subnetStore = useSubnetStore();
const piholeImportRef = ref(null);
const health = ref(null);
const activeScan = ref(null);
let pollInterval = null;
let scanPollInterval = null;

function handleLogout() {
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
  if (!activeScan.value) return 'No Scan';
  const s = activeScan.value;
  if (s.status === 'pending') return 'Pending';
  if (s.status === 'running' && s.total_ips > 0) {
    return `${Math.round((s.scanned_ips / s.total_ips) * 100)}%`;
  }
  if (s.status === 'running') return 'Running';
  return 'No Scan';
});

async function fetchActiveScan() {
  try {
    // Always use the list endpoint (lightweight — no results array)
    const res = await api.get('/scans');
    const active = res.data.find(s => s.status === 'running' || s.status === 'pending');
    activeScan.value = active || null;

    // Start/stop fast polling based on scan state
    if (active && !scanPollInterval) {
      scanPollInterval = setInterval(fetchActiveScan, 2000);
    } else if (!active && scanPollInterval) {
      clearInterval(scanPollInterval);
      scanPollInterval = null;
    }
  } catch { /* ignore */ }
}

async function fetchHealth() {
  try {
    const res = await api.get('/health/system');
    health.value = res.data;
  } catch { /* health endpoint may not be available */ }
}

onMounted(() => {
  fetchHealth();
  fetchActiveScan();
  pollInterval = setInterval(() => { fetchHealth(); fetchActiveScan(); }, 60000);
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
}
.logo-img {
  height: 54px;
  width: auto;
  margin: -10px 0;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3));
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

.user-info {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  margin-left: 0.5rem;
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


</style>
