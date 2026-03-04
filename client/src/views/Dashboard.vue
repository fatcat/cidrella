<template>
  <div class="dashboard">
    <h2>Dashboard</h2>
    <p>Welcome to IPAM. Use the sidebar to navigate.</p>
    <div class="status-cards">
      <div class="status-card">
        <i class="pi pi-server"></i>
        <div>
          <div class="label">DNSmasq</div>
          <div class="value">Running</div>
        </div>
      </div>
      <div class="status-card">
        <i class="pi pi-globe"></i>
        <div>
          <div class="label">DNS Zones</div>
          <div class="value">--</div>
        </div>
      </div>
      <div class="status-card">
        <i class="pi pi-sitemap"></i>
        <div>
          <div class="label">Subnets</div>
          <div class="value">{{ subnetStore.subnetCount }}</div>
        </div>
      </div>
      <div class="status-card">
        <i class="pi pi-list"></i>
        <div>
          <div class="label">DHCP Leases</div>
          <div class="value">--</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { useSubnetStore } from '../stores/subnets.js';

const subnetStore = useSubnetStore();

onMounted(() => {
  if (subnetStore.tree.length === 0) {
    subnetStore.fetchTree();
  }
});
</script>

<style scoped>
.dashboard h2 {
  margin: 0 0 0.5rem 0;
}
.status-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}
.status-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}
.status-card i {
  font-size: 1.5rem;
  color: var(--p-primary-color);
}
.status-card .label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.status-card .value {
  font-size: 1.25rem;
  font-weight: 600;
}
</style>
