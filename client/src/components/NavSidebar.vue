<template>
  <nav class="sidebar">
    <div class="sidebar-header">
      <h2>IPAM</h2>
    </div>
    <ul class="nav-list">
      <li v-for="item in navItems" :key="item.to">
        <router-link :to="item.to" class="nav-link" active-class="active">
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </router-link>
      </li>
    </ul>
    <div class="sidebar-footer">
      <div class="user-info">
        <i class="pi pi-user"></i>
        <span>{{ auth.user?.username }}</span>
        <span class="role-badge">{{ auth.user?.role }}</span>
      </div>
      <button class="logout-btn" @click="handleLogout" title="Sign out">
        <i class="pi pi-sign-out"></i>
      </button>
    </div>
  </nav>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const router = useRouter();
const auth = useAuthStore();

const navItems = [
  { to: '/', label: 'Dashboard', icon: 'pi pi-home' },
  { to: '/subnets', label: 'Subnets', icon: 'pi pi-sitemap' },
  { to: '/dns', label: 'DNS', icon: 'pi pi-globe' },
  { to: '/dhcp', label: 'DHCP', icon: 'pi pi-list' },
  { to: '/blocklists', label: 'Blocklists', icon: 'pi pi-shield' },
  { to: '/system', label: 'System', icon: 'pi pi-cog' }
];

function handleLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.sidebar {
  width: 240px;
  min-height: 100vh;
  background: var(--p-surface-card);
  border-right: 1px solid var(--p-surface-border);
  display: flex;
  flex-direction: column;
}
.sidebar-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.sidebar-header h2 {
  margin: 0;
  color: var(--p-primary-color);
  font-size: 1.25rem;
}
.nav-list {
  list-style: none;
  padding: 0.5rem 0;
  margin: 0;
  flex: 1;
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.5rem;
  text-decoration: none;
  color: var(--p-text-color);
  transition: background 0.15s;
}
.nav-link:hover {
  background: var(--p-surface-hover);
}
.nav-link.active {
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
}
.nav-link i {
  font-size: 1rem;
  width: 1.25rem;
  text-align: center;
}
.sidebar-footer {
  border-top: 1px solid var(--p-surface-border);
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.user-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.role-badge {
  font-size: 0.7rem;
  background: var(--p-surface-200);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  text-transform: uppercase;
}
.logout-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--p-text-muted-color);
  padding: 0.4rem;
  border-radius: 4px;
}
.logout-btn:hover {
  background: var(--p-surface-hover);
  color: var(--p-text-color);
}
</style>
