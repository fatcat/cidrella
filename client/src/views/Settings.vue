<!--
  The A+C Settings shell. Two states from the route query:
    • Home  (no ?area)  — card-grid "front door" (C) + search.
    • Area  (?area=x)   — SettingsArea (A): rail + sub-tabs.
  Routing is query-only (path-agnostic) so this works while previewed at a temp
  route and after it takes over /system. The global <Toast> lives in App.vue.
-->
<template>
  <div class="settings-page">
    <!-- HOME: card grid -->
    <div v-if="!activeAreaId" class="settings-home">
      <div class="home-head">
        <h1>Settings</h1>
        <span class="p-input-icon-left home-search-wrap">
          <i class="pi pi-search" />
          <InputText v-model="search" placeholder="Search settings — try “DNSSEC”, “rogue”, “TLS”…"
                     class="home-search" data-track="settings-search" />
        </span>
      </div>
      <div class="cards">
        <button v-for="a in filteredAreas" :key="a.id" type="button" class="scard"
                :data-track="a.dataTrack" @click="goArea(a.id)">
          <i :class="a.icon" class="scard-ic"></i>
          <span class="scard-name">{{ a.label }}</span>
          <span class="scard-blurb">{{ a.blurb }}</span>
        </button>
      </div>
      <p v-if="filteredAreas.length === 0" class="no-match">No settings match “{{ search }}”.</p>
    </div>

    <!-- AREA: rail + sub-tabs -->
    <SettingsArea v-else :area-id="activeAreaId" :sec="activeSec"
                  @home="goHome" @area="goArea" @sec="goSec" />
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import InputText from 'primevue/inputtext';
import SettingsArea from '../components/settings/SettingsArea.vue';
import { SETTINGS_AREAS, findArea } from '../config/settingsAreas.js';

const route = useRoute();
const router = useRouter();
const search = ref('');

const activeAreaId = computed(() => {
  const a = route.query.area;
  return a && findArea(a) ? a : '';
});
const activeSec = computed(() => (typeof route.query.sec === 'string' ? route.query.sec : ''));

const filteredAreas = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return SETTINGS_AREAS;
  return SETTINGS_AREAS.filter(a =>
    a.label.toLowerCase().includes(q) ||
    a.blurb.toLowerCase().includes(q) ||
    a.subtabs.some(s => s.label.toLowerCase().includes(q)));
});

// Back-compat for the old System.vue deep-links: translate the 5 named ?tab=
// values to the new ?area=&sec= scheme. The old numeric localStorage key is
// dropped (reset to home), not migrated.
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

function goHome() { router.push({ query: {} }); }
function goArea(id) { router.push({ query: { area: id } }); }
function goSec(id) { router.push({ query: { area: activeAreaId.value, sec: id } }); }
</script>

<style scoped>
.settings-page { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.settings-home { padding: 1.25rem 1.5rem; overflow: auto; }
.home-head { display: flex; align-items: center; gap: 1.25rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.home-head h1 { margin: 0; font-size: 1.4rem; font-weight: 650; }
.home-search-wrap { flex: 1; max-width: 460px; }
.home-search { width: 100%; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.9rem; }
.scard { display: flex; flex-direction: column; align-items: flex-start; gap: 0.3rem;
  text-align: left; cursor: pointer; padding: 1rem; border-radius: 10px;
  background: var(--p-content-background); border: 1px solid var(--p-content-border-color);
  transition: transform 0.12s, border-color 0.12s; }
.scard:hover { border-color: var(--p-primary-color); transform: translateY(-2px); }
.scard-ic { font-size: 1.25rem; color: var(--p-primary-color); margin-bottom: 0.25rem; }
.scard-name { font-size: var(--app-fs-base); font-weight: 600; color: var(--p-text-color); }
.scard-blurb { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); line-height: 1.4; }
.no-match { color: var(--p-text-muted-color); font-size: var(--app-fs-sm); margin-top: 1rem; }
</style>
