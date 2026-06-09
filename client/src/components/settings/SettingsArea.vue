<!--
  The "A" half of the A+C Settings shell: a left rail (all areas, grouped, + an
  "All Settings" back-to-grid affordance) and a sub-tab strip for the active area,
  rendering the active sub-tab's component. Driven entirely by settingsAreas.js.
  Navigation is emitted up to Settings.vue, which owns the router.
-->
<template>
  <div class="settings-area">
    <nav class="sa-rail" aria-label="Settings areas">
      <button type="button" class="sa-rail-home" data-track="settings-all" @click="$emit('home')">
        <i class="pi pi-th-large"></i><span>All Settings</span>
      </button>
      <template v-for="group in groups" :key="group">
        <div class="sa-group">{{ group }}</div>
        <button v-for="a in areasInGroup(group)" :key="a.id" type="button"
                class="sa-rail-item" :class="{ active: a.id === areaId }"
                role="tab" :aria-selected="a.id === areaId" :data-track="a.dataTrack"
                @click="$emit('area', a.id)">
          <i :class="a.icon"></i><span>{{ a.label }}</span>
        </button>
      </template>
    </nav>

    <section class="sa-content" v-if="area">
      <div class="sa-head">
        <span class="sa-crumb"><a @click="$emit('home')">Settings</a> › <b>{{ area.label }}</b></span>
        <h2 class="sa-title">{{ area.label }}</h2>
      </div>

      <div v-if="subtabs.length > 1" class="sa-subtabs" role="tablist">
        <button v-for="st in subtabs" :key="st.id" type="button"
                class="sa-subtab" :class="{ active: st.id === activeSecId }"
                role="tab" :aria-selected="st.id === activeSecId" :data-track="st.dataTrack"
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
import { computed } from 'vue';
import { SETTINGS_AREAS, SETTINGS_GROUPS, findArea } from '../../config/settingsAreas.js';

const props = defineProps({
  areaId: { type: String, required: true },
  sec: { type: String, default: '' },
});
defineEmits(['home', 'area', 'sec']);

const groups = SETTINGS_GROUPS;
const area = computed(() => findArea(props.areaId));
const subtabs = computed(() => area.value?.subtabs || []);
const activeSecId = computed(() => {
  const ids = subtabs.value.map(s => s.id);
  return ids.includes(props.sec) ? props.sec : (ids[0] || '');
});
const activeSubtab = computed(() => subtabs.value.find(s => s.id === activeSecId.value) || null);

function areasInGroup(group) {
  return SETTINGS_AREAS.filter(a => a.group === group);
}
</script>

<style scoped>
.settings-area { display: flex; height: 100%; min-height: 0; }

/* Rail */
.sa-rail { width: 210px; flex: 0 0 auto; overflow: auto; padding: 0.75rem 0.5rem;
  border-right: 1px solid var(--p-content-border-color); background: var(--p-content-background); }
.sa-rail-home, .sa-rail-item {
  display: flex; align-items: center; gap: 0.55rem; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer; color: var(--p-text-color);
  font-size: var(--app-fs-sm); padding: 0.42rem 0.6rem; border-radius: 6px; }
.sa-rail-home { color: var(--p-primary-color); margin-bottom: 0.4rem; }
.sa-rail-home:hover, .sa-rail-item:hover { background: var(--p-content-hover-background); }
.sa-rail-item.active { background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
  color: var(--p-primary-color); font-weight: 600; }
.sa-rail-item .pi, .sa-rail-home .pi { width: 16px; text-align: center; opacity: 0.85; }
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
   root with an internal scrollHeight="flex" table — clip the panel so ONLY that
   table scrolls (no outer scrollbar). */
.sa-panel.fill { overflow: hidden; }
.sa-crumb { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); }
.sa-crumb a { color: var(--p-primary-color); cursor: pointer; }
.sa-crumb b { color: var(--p-text-color); }
.sa-title { margin: 0.15rem 0 0.9rem; font-size: 1.25rem; font-weight: 650; }
.sa-subtabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--p-content-border-color);
  margin-bottom: 1.1rem; flex-wrap: wrap; }
.sa-subtab { background: none; border: none; cursor: pointer; color: var(--p-text-muted-color);
  font-size: var(--app-fs-sm); padding: 0.55rem 0.85rem; border-bottom: 2px solid transparent; }
.sa-subtab:hover { color: var(--p-text-color); }
.sa-subtab.active { color: var(--p-primary-color); border-bottom-color: var(--p-primary-color); font-weight: 600; }
</style>
