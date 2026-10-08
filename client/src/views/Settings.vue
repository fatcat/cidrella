<!--
  The Settings shell. One state: the area view (rail + sub-tabs).

  This used to be two states driven by the route query: no ?area gave a
  card-grid "front door", ?area=x gave the rail. The card grid was removed in
  v0.4.17 because it listed exactly the same eight areas the rail already lists,
  grouped the same way, so it was a click in front of the navigation rather than
  navigation. Clicking Settings now lands straight on the hierarchy.

  Routing stays query-only (path-agnostic). ?area is still honoured for
  deep-links and is simply defaulted when absent. The global <Toast> lives in
  App.vue.
-->
<template>
  <div class="settings-page">
    <div v-if="returnPath" class="settings-return">
      <router-link :to="returnPath"><i class="pi pi-arrow-left" /> Return to workspace</router-link>
    </div>
    <SettingsArea :area-id="activeAreaId" :sec="activeSec" @area="goArea" @sec="goSec" />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsArea from '../components/settings/SettingsArea.vue';
import { SETTINGS_AREAS, findArea } from '../config/settingsAreas.js';
import { safeInternalPath } from '../utils/landing.js';

const route = useRoute();
const router = useRouter();

// First area in the catalog is the landing area when the URL names none. Read
// from settingsAreas.js rather than hardcoded, so reordering that list moves
// the landing page with it.
const DEFAULT_AREA_ID = SETTINGS_AREAS[0].id;

const activeAreaId = computed(() => {
  const a = route.query.area;
  return a && findArea(a) ? a : DEFAULT_AREA_ID;
});
const activeSec = computed(() => (typeof route.query.sec === 'string' ? route.query.sec : ''));
const returnPath = computed(() => safeInternalPath(router, route.query.return));

function queryWithReturn(query) {
  return returnPath.value ? { ...query, return: returnPath.value } : query;
}

// Back-compat for the old System.vue deep-links: translate the 5 named ?tab=
// values to the new ?area=&sec= scheme. The old numeric localStorage key is
// dropped, not migrated.
const LEGACY_TAB = {
  updates: { area: 'maintenance', sec: 'updates' },
  backup: { area: 'maintenance', sec: 'backup' },
  certificates: { area: 'access', sec: 'certificate' },
  logging: { area: 'maintenance', sec: 'logs' },
  import: { area: 'maintenance', sec: 'import' },
};
onMounted(() => {
  localStorage.removeItem('cidrella_system_tab');
  const legacy = typeof route.query.tab === 'string' ? LEGACY_TAB[route.query.tab] : null;
  if (legacy) router.replace({ query: { area: legacy.area, sec: legacy.sec } });
});

function goArea(id) {
  router.push({ query: queryWithReturn({ area: id }) });
}
function goSec(id) {
  router.push({ query: queryWithReturn({ area: activeAreaId.value, sec: id }) });
}
</script>

<style scoped>
.settings-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.settings-return {
  padding: 0.45rem 0.8rem;
  border-bottom: 1px solid var(--cid-surface-border);
  background: var(--cid-surface-card);
}
.settings-return a {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--cid-primary-color);
  font-size: var(--app-fs-sm);
  font-weight: 700;
  text-decoration: none;
}
</style>
