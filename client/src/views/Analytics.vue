<template>
  <div class="analytics-page">
    <aside class="ana-sidebar">
      <nav class="ana-nav">
        <a v-for="item in menuItems" :key="item.tabIndex"
           class="ana-nav-item" :class="{ active: activeTab === item.tabIndex }"
          :data-track="item.dataTrack" @click="activeTab = item.tabIndex">
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </a>
      </nav>
    </aside>

    <div class="ana-content">
      <DashboardPanel v-if="activeTab === 0" />

      <PerformancePanel v-if="activeTab === 1" />

      <IntelligencePanel v-if="activeTab === 2" />

      <AnomaliesPanel v-if="activeTab === 3" />
    </div>
  </div>
</template>

<script setup>
import { ref, watch, defineAsyncComponent } from 'vue';

const AsyncLoader = defineAsyncComponent(() => import('../components/AsyncLoader.vue'));

function asyncTab(loader) {
  return defineAsyncComponent({
    loader,
    loadingComponent: AsyncLoader,
    delay: 200,
  });
}

const DashboardPanel = asyncTab(() => import('./Dashboard.vue'));
const PerformancePanel = asyncTab(() => import('./Performance.vue'));
const IntelligencePanel = asyncTab(() => import('./Intelligence.vue'));
const AnomaliesPanel = asyncTab(() => import('./Anomalies.vue'));

const menuItems = [
  { tabIndex: 0, label: 'Dashboard', icon: 'pi pi-objects-column', dataTrack: 'ana-tab-dashboard' },
  { tabIndex: 1, label: 'Performance', icon: 'pi pi-chart-bar', dataTrack: 'ana-tab-performance' },
  { tabIndex: 2, label: 'Intelligence', icon: 'pi pi-microchip-ai', dataTrack: 'ana-tab-intelligence' },
  { tabIndex: 3, label: 'Anomalies', icon: 'pi pi-exclamation-triangle', dataTrack: 'ana-tab-anomalies' },
];

const activeTab = ref(parseInt(localStorage.getItem('cidrella_analytics_tab') || '0', 10));

watch(activeTab, (val) => {
  localStorage.setItem('cidrella_analytics_tab', String(val));
});

</script>

<style scoped>
.analytics-page {
  padding: 0;
  height: 100%;
  display: flex;
  flex-direction: row;
  box-sizing: border-box;
}

.ana-sidebar {
  width: 180px;
  flex-shrink: 0;
  background: var(--p-surface-card);
  border-right: 1px solid var(--p-surface-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.ana-nav {
  display: flex;
  flex-direction: column;
  padding: 0.25rem 0;
}

.ana-nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: var(--app-fs-base);
  color: var(--p-text-color);
  text-decoration: none;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.1s, border-color 0.1s;
}

.ana-nav-item:hover {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}

.ana-nav-item.active {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  color: var(--p-primary-color);
  font-weight: 600;
  border-left-color: var(--p-primary-color);
  padding-left: calc(1rem - 0px); /* border replaces padding room */
}

.ana-nav-item i {
  width: 1.25rem;
  text-align: center;
  font-size: 0.9rem;
}

.ana-content {
  flex: 1;
  overflow: auto;
}

.content-card {
  margin: 3% 7% 0;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}

.placeholder-card {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--p-text-muted-color);
}

.placeholder-icon {
  font-size: 2.5rem;
  margin-bottom: 0.75rem;
  opacity: 0.4;
}

.placeholder-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  color: var(--p-text-color);
}

.placeholder-card p {
  margin: 0;
  font-size: 0.85rem;
}
</style>
