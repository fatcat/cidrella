<template>
  <header class="header-bar">
    <div class="header-left">
      <router-link to="/" class="logo">IPAM</router-link>
    </div>

    <div class="header-stats">
      <div class="stat-item" :class="health?.services?.dnsmasq ? 'stat-ok' : 'stat-err'">
        <span class="stat-dot"></span>
        <span class="stat-label">DNSmasq</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ health?.stats?.dns_zones ?? '--' }}</span>
        <span class="stat-label">DNS Zones</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ health?.stats?.subnets ?? subnetStore.subnetCount }}</span>
        <span class="stat-label">Subnets</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ health?.stats?.dhcp_scopes ?? '--' }}</span>
        <span class="stat-label">DHCP Scopes</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ health?.stats?.dhcp_leases ?? '--' }}</span>
        <span class="stat-label">Leases</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ health?.stats?.dns_records ?? '--' }}</span>
        <span class="stat-label">DNS Records</span>
      </div>
    </div>

    <div class="header-right">
      <Button :label="isSystemView ? 'IP Management' : 'System'"
              :icon="isSystemView ? 'pi pi-sitemap' : 'pi pi-cog'"
              severity="secondary" size="small"
              @click="router.push(isSystemView ? '/' : '/system')" />

      <div class="user-info">
        <span class="username">{{ auth.user?.username }}</span>
        <span class="role-badge">{{ auth.user?.role }}</span>
      </div>
      <Button icon="pi pi-sign-out" severity="secondary" text rounded size="small"
              title="Sign out" @click="handleLogout" />
    </div>
  </header>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Button from 'primevue/button';
import { useAuthStore } from '../stores/auth.js';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';

const router = useRouter();
const route = useRoute();
const isSystemView = computed(() => route.path === '/system');
const auth = useAuthStore();
const subnetStore = useSubnetStore();
const health = ref(null);
let pollInterval = null;

function handleLogout() {
  auth.logout();
  router.push('/login');
}

async function fetchHealth() {
  try {
    const res = await api.get('/health/system');
    health.value = res.data;
  } catch { /* health endpoint may not be available */ }
}

onMounted(() => {
  fetchHealth();
  pollInterval = setInterval(fetchHealth, 60000);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});
</script>

<style scoped>
.header-bar {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 1rem;
  background: var(--p-surface-card);
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
  gap: 1rem;
}

.header-left {
  flex-shrink: 0;
}

.logo {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--p-primary-color);
  text-decoration: none;
}

.header-stats {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex: 1;
  justify-content: center;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  white-space: nowrap;
}

.stat-value {
  font-weight: 700;
  font-size: 0.9rem;
}

.stat-label {
  color: var(--p-text-muted-color);
}

.stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stat-ok .stat-dot { background: #22c55e; }
.stat-err .stat-dot { background: #ef4444; }

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
  background: var(--p-surface-200);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  text-transform: uppercase;
}
</style>
