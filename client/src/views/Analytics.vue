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
      <p v-if="elsewhere" class="status-line elsewhere-line" data-track="ana-managed-elsewhere">
        <StatusDot kind="info" label="Managed on the controller" />
        <span>{{ elsewhere }} is managed on {{ controllerName }}.</span>
        <a
          v-if="controllerUrl"
          :href="controllerUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-track="ana-open-controller"
          >Open {{ controllerName }}</a
        >
      </p>

      <DashboardPanel v-if="activeTab === 'dashboard'" />

      <PerformancePanel v-if="activeTab === 'performance'" />

      <IntelligencePanel v-if="activeTab === 'intelligence'" />

      <AnomaliesPanel v-if="activeTab === 'anomalies'" />

      <ResolutionMapPanel v-if="activeTab === 'map'" />
    </div>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatusDot from '../components/StatusDot.vue';
import { useFeatures } from '../composables/useFeatures.js';
import { analyticsSections, defaultAnalyticsView } from '../utils/member-ui.js';

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
const ResolutionMapPanel = asyncTab(() => import('./ResolutionMap.vue'));

const route = useRoute();
const router = useRouter();
const features = useFeatures();

// The sections this box shows: a member has no Dashboard or Anomalies, and
// opens on Performance (utils/member-ui.js).
const menuItems = computed(() => analyticsSections(features.isMember.value));
const tabIds = computed(() => new Set(menuItems.value.map((item) => item.id)));
// The saved tab is stored by its index in this list, so its order is fixed.
const legacyTabs = ['dashboard', 'performance', 'intelligence', 'anomalies', 'map'];
const TAB_KEY = 'cidrella_analytics_tab';

function readSavedTab() {
  try {
    return legacyTabs[Number(localStorage.getItem(TAB_KEY))] || '';
  } catch {
    return '';
  }
}
const savedTab = readSavedTab();

const activeTab = computed(() => {
  const requested = typeof route.query.view === 'string' ? route.query.view : '';
  if (tabIds.value.has(requested)) return requested;
  return tabIds.value.has(savedTab) ? savedTab : defaultAnalyticsView(features.isMember.value);
});

// A member sent here for a page it does not show (router/index.js) names that
// page once, with a link to the controller, and drops the query so a reload
// or a bookmark of this page does not repeat it.
const elsewhere = ref('');
const controllerName = computed(() => features.instance.value.controller_name || 'the controller');
const controllerUrl = computed(() => features.instance.value.controller_url);
function selectTab(id) {
  if (!tabIds.value.has(id) || id === activeTab.value) return;
  elsewhere.value = '';
  router.push({ query: { ...route.query, view: id } });
}

watch(activeTab, (val) => {
  try {
    localStorage.setItem(TAB_KEY, String(legacyTabs.indexOf(val)));
  } catch {
    // A browser that keeps nothing opens on the default next time.
  }
});

watch(
  () => route.query.elsewhere,
  (label) => {
    if (typeof label !== 'string' || !label) return;
    elsewhere.value = label;
    const rest = { ...route.query };
    delete rest.elsewhere;
    void router.replace({ query: rest });
  },
  { immediate: true },
);
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
  transition:
    background 0.1s,
    box-shadow 0.1s;
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
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--cid-primary-color) 45%, var(--cid-surface-border));
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

.elsewhere-line {
  margin: 0.75rem 1rem 0;
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

  /* The narrow layout is a tab strip: the current tab is underlined. */
  .ana-nav-item.active {
    box-shadow: none;
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
