<template>
  <header class="header-bar">
    <div class="header-left">
      <router-link to="/" class="logo"><img src="/logo.png" alt="CIDRella" class="logo-img" /></router-link>
    </div>

    <div class="header-cards-wrapper">
      <div class="header-cards">
      <div class="dash-card" :class="health?.services?.dnsmasq ? 'card-ok' : 'card-err'">
        <div class="card-body">
          <span class="card-value">{{ health?.services?.dnsmasq ? 'Running' : 'Down' }}</span>
          <span class="card-label">DNSmasq</span>
        </div>
      </div>

      <div class="dash-card" :class="dnsStatusClass" v-tooltip.bottom="dnsTooltip">
        <div class="card-body">
          <span class="card-value">{{ dnsStatusLabel }}</span>
          <span class="card-label">Name Resolution</span>
        </div>
      </div>

      <div class="dash-card" :class="cpuStatusClass">
        <div class="card-body">
          <span class="card-value">{{ cpuDisplay }}</span>
          <span class="card-label">CPU Load</span>
        </div>
      </div>

      <div class="dash-card" :class="ramStatusClass">
        <div class="card-body">
          <span class="card-value">{{ ramDisplay }}</span>
          <span class="card-label">RAM</span>
        </div>
      </div>

      <div class="dash-card" :class="diskStatusClass">
        <div class="card-body">
          <span class="card-value">{{ diskDisplay }}</span>
          <span class="card-label">Disk</span>
        </div>
      </div>

      <div class="dash-card">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.subnets ?? subnetStore.subnetCount }}</span>
          <span class="card-label">Networks</span>
        </div>
      </div>

      <div class="dash-card">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dns_zones ?? '--' }}</span>
          <span class="card-label">DNS Zones</span>
        </div>
      </div>

      <div class="dash-card">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dhcp_scopes ?? '--' }}</span>
          <span class="card-label">DHCP Scopes</span>
        </div>
      </div>

      <div class="dash-card">
        <div class="card-body">
          <span class="card-value">{{ health?.stats?.dhcp_leases ?? '--' }}</span>
          <span class="card-label">Leases</span>
        </div>
      </div>
      </div>
    </div>

    <div class="header-right">
      <div class="status-area" ref="statusAreaRef">
        <button v-if="systemAlerts.length === 0" class="status-btn status-ok">
          All Systems Green
        </button>
        <button v-else class="status-btn status-error" @click="statusDropdownOpen = !statusDropdownOpen">
          {{ systemAlerts.length === 1 ? 'System Error' : `${systemAlerts.length} Errors` }}
        </button>
        <div v-if="statusDropdownOpen && systemAlerts.length > 0" class="status-dropdown">
          <div v-for="(alert, i) in systemAlerts" :key="i" class="status-alert-row"
               @click="openAlertDetail(alert)">
            <i class="pi pi-exclamation-circle" style="color: #ef4444; flex-shrink: 0"></i>
            <span>{{ alert.summary }}</span>
          </div>
        </div>
      </div>
      <div class="user-info">
        <span class="username">{{ auth.user?.username }}</span>
        <span class="role-badge">{{ auth.user?.role }}</span>
      </div>
      <Button icon="pi pi-sign-out" severity="secondary" text rounded size="small"
              title="Sign out" @click="handleLogout" />
    </div>

    <!-- Alert Detail Dialog -->
    <Dialog v-model:visible="showAlertDetail" :header="alertDetailData?.summary" modal :style="{ width: '28rem' }">
      <p style="margin: 0; line-height: 1.6">{{ alertDetailData?.detail }}</p>
    </Dialog>

  </header>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { useAuthStore } from '../stores/auth.js';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';

const router = useRouter();

const auth = useAuthStore();
const subnetStore = useSubnetStore();
const health = ref(null);
let pollInterval = null;

function handleLogout() {
  auth.logout();
  router.push('/login');
}

// ── System Status Alerts ──
const statusDropdownOpen = ref(false);
const showAlertDetail = ref(false);
const alertDetailData = ref(null);
const statusAreaRef = ref(null);

const systemAlerts = computed(() => {
  const h = health.value;
  if (!h) return [];
  const alerts = [];

  if (h.services?.dnsmasq === false) {
    alerts.push({ summary: 'DNSmasq is not running', detail: 'The DNSmasq process has stopped or failed to start. DHCP and DNS services are unavailable. Check container logs for details.' });
  }
  if (h.dns && !h.dns.ok) {
    const downServers = h.dns.servers?.filter(s => s.status !== 'up').map(s => s.server) || [];
    const detail = h.dns.systemResolution === false
      ? `System-level DNS resolution is failing. ${downServers.length > 0 ? `Unreachable upstream servers: ${downServers.join(', ')}` : 'No upstream servers responded.'}`
      : `Some upstream DNS servers are unreachable: ${downServers.join(', ')}`;
    alerts.push({ summary: 'Name resolution failing', detail });
  } else if (h.dns?.systemResolution === false) {
    alerts.push({ summary: 'System DNS resolution failed', detail: 'The local resolver cannot resolve hostnames, but upstream servers may still be reachable.' });
  }
  if (h.disk && h.disk.percent >= 90) {
    alerts.push({ summary: `Disk usage critical (${h.disk.percent}%)`, detail: `The /data volume is ${h.disk.percent}% full. Used: ${formatBytes(h.disk.used)} of ${formatBytes(h.disk.total)}. Free up space or expand the volume to avoid service disruption.` });
  }
  if (h.memory && h.memory.total > 0 && (h.memory.used / h.memory.total) >= 0.95) {
    const pct = Math.round((h.memory.used / h.memory.total) * 100);
    alerts.push({ summary: `Memory usage critical (${pct}%)`, detail: `Used: ${formatBytes(h.memory.used)} of ${formatBytes(h.memory.total)}. Free: ${formatBytes(h.memory.free)}. Consider increasing container memory limits.` });
  }
  if (h.cpu && h.cpu.cores > 0 && h.cpu.loadAvg[0] > h.cpu.cores * 2) {
    const load = h.cpu.loadAvg;
    alerts.push({ summary: `CPU load very high (${load[0].toFixed(1)})`, detail: `Load averages: ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)} (1/5/15 min) across ${h.cpu.cores} cores. Sustained high load may degrade service performance.` });
  }

  return alerts;
});

function openAlertDetail(alert) {
  alertDetailData.value = alert;
  statusDropdownOpen.value = false;
  showAlertDetail.value = true;
}

function onDocumentClick(e) {
  if (statusAreaRef.value && !statusAreaRef.value.contains(e.target)) {
    statusDropdownOpen.value = false;
  }
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

const dnsStatusClass = computed(() => {
  const dns = health.value?.dns;
  if (!dns) return '';
  return dns.ok ? 'card-ok' : 'card-err';
});

const dnsStatusLabel = computed(() => {
  const dns = health.value?.dns;
  if (!dns) return '--';
  return dns.ok ? 'OK' : 'Down';
});

const dnsTooltip = computed(() => {
  const dns = health.value?.dns;
  if (!dns) return { value: 'Loading...', escape: false };
  const lines = [];
  const ok = '<span style="color:#22c55e">OK</span>';
  const fail = '<span style="color:#ef4444">DOWN</span>';
  lines.push(`<strong>System resolution:</strong> ${dns.systemResolution ? ok : fail}`);
  if (dns.servers?.length > 0) {
    lines.push('<hr style="border:0;border-top:1px solid rgba(255,255,255,0.15);margin:4px 0">');
    lines.push('<strong>Upstream Servers</strong>');
    for (const s of dns.servers) {
      const escaped = s.server.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      lines.push(`${escaped} — ${s.status === 'up' ? ok : fail}`);
    }
  } else {
    lines.push('No upstream DNS servers configured');
  }
  return { value: lines.join('<br>'), escape: false };
});

async function fetchHealth() {
  try {
    const res = await api.get('/health/system');
    health.value = res.data;
  } catch { /* health endpoint may not be available */ }
}

onMounted(() => {
  fetchHealth();
  pollInterval = setInterval(fetchHealth, 60000);
  window.addEventListener('ipam:stats-changed', fetchHealth);
  document.addEventListener('mousedown', onDocumentClick);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
  window.removeEventListener('ipam:stats-changed', fetchHealth);
  document.removeEventListener('mousedown', onDocumentClick);
});
</script>

<style scoped>
.header-bar {
  display: flex;
  align-items: center;
  padding: 0.5rem 1rem;
  background: var(--ipam-card);
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
  background: var(--ipam-card);
  border-radius: 6px;
  flex-shrink: 1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
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

.dash-card.card-ok { border-left: 3px solid #22c55e; }
.dash-card.card-err { border-left: 3px solid #ef4444; }
.card-ok .card-value { color: #ffffff; font-weight: 700; }
.card-err .card-value { color: #ffffff; font-weight: 700; }

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

/* ── System Status ── */
.status-area {
  position: relative;
}
.status-btn {
  height: 26px;
  padding: 0 0.6rem;
  border-radius: 6px;
  font-size: 0.7rem;
  font-weight: 600;
  cursor: default;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
  transition: all 0.15s;
}
.status-ok {
  border: 1px solid #22c55e;
  background: color-mix(in srgb, #22c55e 10%, transparent);
  color: #22c55e;
}
.status-error {
  border: 1px solid #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
  color: #ef4444;
  cursor: pointer;
}
.status-error:hover {
  background: color-mix(in srgb, #ef4444 20%, transparent);
}
.status-dropdown {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  min-width: 280px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  z-index: 1000;
}
.status-alert-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.1s;
}
.status-alert-row:last-child {
  border-bottom: none;
}
.status-alert-row:hover {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}

</style>
