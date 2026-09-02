<!--
  The Settings shell body: a left rail listing every area, grouped, and a sub-tab
  strip for the active one. Driven entirely by settingsAreas.js. Navigation is
  emitted up to Settings.vue, which owns the router.

  The card-grid front door was removed in v0.4.17, and with it the "All Settings"
  rail button and the breadcrumb link that existed only to go back to it. The
  rail already listed the same eight areas in the same groups, so the grid was a
  click in front of the navigation. Its search moved here, because filtering the
  rail is the one thing the grid did that the rail could not.
-->
<template>
  <div class="settings-area">
    <nav class="sa-rail" aria-label="Settings areas">
      <div class="sa-search-wrap">
        <i class="pi pi-search sa-search-ic"></i>
        <input v-model="search" type="search" class="sa-search" data-track="settings-search"
               placeholder="Search settings" aria-label="Search settings" />
      </div>
      <template v-for="group in visibleGroups" :key="group">
        <div class="sa-group">{{ group }}</div>
        <!-- Plain nav buttons, not a tab widget: aria-current marks the active
             area. Don't add role="tab" here. A tab role outside a tablist
             (and without tabpanel/keyboard wiring) misleads assistive tech. -->
        <button v-for="a in matchingAreasInGroup(group)" :key="a.id" type="button"
                class="sa-rail-item" :class="{ active: a.id === areaId }"
                :aria-current="a.id === areaId ? 'page' : undefined" :data-track="a.dataTrack"
                @click="$emit('area', a.id)">
          <i :class="a.icon"></i><span>{{ a.label }}</span>
        </button>
      </template>
      <p v-if="visibleGroups.length === 0" class="sa-no-match">No settings match “{{ search }}”.</p>
    </nav>

    <section class="sa-content" v-if="area">
      <div class="sa-head">
        <h2 class="sa-title">{{ area.label }}</h2>
      </div>

      <div v-if="subtabs.length > 1" class="sa-subtabs" aria-label="Section">
        <button v-for="st in subtabs" :key="st.id" type="button"
                class="sa-subtab" :class="{ active: st.id === activeSecId }"
                :aria-current="st.id === activeSecId ? 'true' : undefined" :data-track="st.dataTrack"
                @click="$emit('sec', st.id)">{{ st.label }}</button>
      </div>

      <div class="sa-panel" :class="{ fill: activeSubtab && activeSubtab.fill }">
        <keep-alive>
          <component v-if="activeSubtab && activeSubtab.keepAlive" :is="activeSubtab.component" :key="area.id + ':' + activeSecId" />
        </keep-alive>
        <component v-if="activeSubtab && !activeSubtab.keepAlive" :is="activeSubtab.component" :key="area.id + ':' + activeSecId" />
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { SETTINGS_AREAS, SETTINGS_GROUPS, findArea } from '../../config/settingsAreas.js';

const props = defineProps({
  areaId: { type: String, required: true },
  sec: { type: String, default: '' },
});
defineEmits(['area', 'sec']);

const area = computed(() => findArea(props.areaId));
const subtabs = computed(() => area.value?.subtabs || []);
const activeSecId = computed(() => {
  const ids = subtabs.value.map(s => s.id);
  return ids.includes(props.sec) ? props.sec : (ids[0] || '');
});
const activeSubtab = computed(() => subtabs.value.find(s => s.id === activeSecId.value) || null);

const search = ref('');

/**
 * Rail filter. Matches the same three things the card grid's search matched:
 * the area label, its blurb, and the labels of its sub-tabs. The blurb is no
 * longer rendered anywhere, but it stays searchable on purpose: it is the only
 * place a word like "DNSSEC" is associated with the DNS area, which is exactly
 * the lookup this box exists for.
 */
function areaMatches(a, q) {
  if (!q) return true;
  return a.label.toLowerCase().includes(q)
    || a.blurb.toLowerCase().includes(q)
    || a.subtabs.some(st => st.label.toLowerCase().includes(q));
}

function matchingAreasInGroup(group) {
  const q = search.value.trim().toLowerCase();
  return SETTINGS_AREAS.filter(a => a.group === group && areaMatches(a, q));
}

// A group header with nothing under it is noise, so groups collapse out of the
// rail entirely once the filter empties them.
const visibleGroups = computed(() =>
  SETTINGS_GROUPS.filter(g => matchingAreasInGroup(g).length > 0));
</script>

<style scoped>
.settings-area { display: flex; height: 100%; min-height: 0; }

/* Rail */
.sa-rail { width: 210px; flex: 0 0 auto; overflow: auto; padding: 0.75rem 0.5rem;
  border-right: 1px solid var(--p-content-border-color); background: var(--p-content-background); }
.sa-rail-item {
  display: flex; align-items: center; gap: 0.55rem; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer; color: var(--p-text-color);
  font-size: var(--app-fs-sm); padding: 0.42rem 0.6rem; border-radius: 6px; }
.sa-rail-item:hover { background: var(--p-content-hover-background); }
.sa-rail-item.active { background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
  color: var(--p-primary-color); font-weight: 600; }
.sa-rail-item .pi { width: 16px; text-align: center; opacity: 0.85; }
.sa-search-wrap { position: relative; margin: 0 0.2rem 0.6rem; }
.sa-search-ic { position: absolute; left: 0.5rem; top: 50%; transform: translateY(-50%);
  font-size: 0.75rem; color: var(--p-text-muted-color); pointer-events: none; }
.sa-search { width: 100%; padding: 0.35rem 0.5rem 0.35rem 1.6rem; border-radius: 6px;
  font-size: var(--app-fs-xs); color: var(--p-text-color);
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color); }
.sa-search:focus { outline: none; border-color: var(--p-primary-color); }
.sa-no-match { color: var(--p-text-muted-color); font-size: var(--app-fs-xs);
  padding: 0.4rem 0.6rem; line-height: 1.4; }
.sa-group { color: var(--p-text-muted-color); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.6px; margin: 0.8rem 0.55rem 0.25rem; }

/* Content */
.sa-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  padding: 1.1rem 1.4rem; overflow: hidden; }
.sa-head, .sa-subtabs { flex: 0 0 auto; }
/* Plain bounded scroll container (NOT a flex box): panels with `height:100%`
   (DHCP/GeoIP/Blocklists/Users/VLANs) fill it exactly so only their inner table
   scrolls; shorter form panels overflow and scroll the panel itself. A flex
   container here produced a second (outer) scrollbar on the fill panels. */
.sa-panel { flex: 1; min-height: 0; overflow: auto; }
/* Fill panels (DHCP/GeoIP/Blocklists/Users/Calculator/VLANs) have a `height:100%`
   root with an internal scrollHeight="flex" table. Clip the panel so ONLY that
   table scrolls (no outer scrollbar). */
.sa-panel.fill { overflow: hidden; }
.sa-title { margin: 0.15rem 0 0.9rem; font-size: 1.25rem; font-weight: 650; }
.sa-subtabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--p-content-border-color);
  margin-bottom: 1.1rem; flex-wrap: wrap; }
.sa-subtab { background: none; border: none; cursor: pointer; color: var(--p-text-muted-color);
  font-size: var(--app-fs-sm); padding: 0.55rem 0.85rem; border-bottom: 2px solid transparent; }
.sa-subtab:hover { color: var(--p-text-color); }
.sa-subtab.active { color: var(--p-primary-color); border-bottom-color: var(--p-primary-color); font-weight: 600; }
</style>
