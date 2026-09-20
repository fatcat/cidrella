<template>
  <div class="analytics-page">
    <aside class="ana-sidebar">
      <nav class="ana-nav">
        <button
          v-for="item in menuItems"
          :key="item.id"
          type="button"
          class="ana-nav-item"
          :class="{ active: activeTab === item.id }"
          :data-track="item.dataTrack"
          :aria-current="activeTab === item.id ? 'page' : undefined"
          @click="selectTab(item.id)"
        >
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <div class="ana-content">
      <DashboardPanel v-if="activeTab === 'dashboard'" />

      <PerformancePanel v-if="activeTab === 'performance'" />

      <IntelligencePanel v-if="activeTab === 'intelligence'" />

      <AnomaliesPanel v-if="activeTab === 'anomalies'" />
    </div>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

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
const AnomaliesPanel = asyncTab(() => import('./AnomaliesWorkspace.vue'));

const menuItems = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'pi pi-objects-column',
    dataTrack: 'ana-tab-dashboard',
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'pi pi-chart-bar',
    dataTrack: 'ana-tab-performance',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: 'pi pi-microchip-ai',
    dataTrack: 'ana-tab-intelligence',
  },
  {
    id: 'anomalies',
    label: 'Anomalies',
    icon: 'pi pi-exclamation-triangle',
    dataTrack: 'ana-tab-anomalies',
  },
];

const route = useRoute();
const router = useRouter();
const tabIds = new Set(menuItems.map((item) => item.id));
const legacyTabs = ['dashboard', 'performance', 'intelligence', 'anomalies'];

const savedTab = legacyTabs[Number(localStorage.getItem('cidrella_analytics_tab'))] || 'dashboard';
const activeTab = computed(() => {
  const requested = typeof route.query.view === 'string' ? route.query.view : '';
  return tabIds.has(requested) ? requested : savedTab;
});

function selectTab(id) {
  if (!tabIds.has(id) || id === activeTab.value) return;
  router.push({ query: { ...route.query, view: id } });
}

watch(activeTab, (val) => {
  localStorage.setItem('cidrella_analytics_tab', String(legacyTabs.indexOf(val)));
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
  background: var(--cid-surface-card);
  border-right: 1px solid var(--cid-surface-border);
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
  color: var(--cid-text-color);
  text-decoration: none;
  width: 100%;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition:
    background 0.1s,
    border-color 0.1s;
}

.ana-nav-item:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: -2px;
}

.ana-nav-item:hover {
  background: color-mix(in srgb, var(--cid-primary-color) 8%, transparent);
}

.ana-nav-item.active {
  background: color-mix(in srgb, var(--cid-primary-color) 15%, transparent);
  color: var(--cid-primary-color);
  font-weight: 600;
  border-left-color: var(--cid-primary-color);
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

@media (max-width: 768px) {
  .analytics-page {
    flex-direction: column;
  }

  .ana-sidebar {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: 0;
    border-bottom: 1px solid var(--cid-surface-border);
  }

  .ana-nav {
    flex-direction: row;
    min-width: max-content;
  }

  .ana-nav-item {
    width: auto;
    border-left: 0;
    border-bottom: 3px solid transparent;
    white-space: nowrap;
  }

  .ana-nav-item.active {
    border-left-color: transparent;
    border-bottom-color: var(--cid-primary-color);
    padding-left: 1rem;
  }
}

.content-card {
  margin: 3% 7% 0;
  padding: 1.25rem;
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
}

.placeholder-card {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--cid-text-muted-color);
}

.placeholder-icon {
  font-size: 2.5rem;
  margin-bottom: 0.75rem;
  opacity: 0.4;
}

.placeholder-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  color: var(--cid-text-color);
}

.placeholder-card p {
  margin: 0;
  font-size: 0.85rem;
}
</style>
