<template>
  <div class="workspace-preview settings-workspace" data-track="settings-workspace-preview">
    <section class="workspace-frame">
      <nav class="explorer" aria-label="Settings areas">
        <div class="explorer-search">
          <i class="pi pi-search" />
          <input
            v-model="search"
            type="search"
            data-track="settings-search"
            placeholder="Search settings"
            aria-label="Search settings"
          />
        </div>
        <template v-for="group in visibleGroups" :key="group">
          <span class="eyebrow">{{ group }}</span>
          <button
            v-for="entry in areasInGroup(group)"
            :key="entry.id"
            class="area-row"
            :class="{ active: entry.id === area.id }"
            :aria-current="entry.id === area.id ? 'page' : undefined"
            :data-track="entry.dataTrack"
            @click="emitArea(entry.id)"
          >
            <i :class="entry.icon" />
            <span class="area-copy">
              <strong>{{ entry.label }}</strong>
              <small>{{ entry.blurb }}</small>
            </span>
            <span class="area-count">{{ entry.subtabs.length }}</span>
          </button>
        </template>
        <p v-if="!visibleGroups.length" class="explorer-empty">No settings match “{{ search }}”.</p>
      </nav>

      <section class="work-surface" aria-label="Settings work surface">
        <header class="context-header">
          <div class="context-breadcrumb">
            <span>Settings</span>
            <i class="pi pi-chevron-right" />
            <span>{{ area.group }}</span>
            <i class="pi pi-chevron-right" />
            <span>{{ area.label }}</span>
            <router-link
              v-if="returnPath"
              :to="returnPath"
              class="return-link"
              data-track="settings-workspace-return"
            >
              <i class="pi pi-arrow-left" /> Return to workspace
            </router-link>
          </div>
          <div class="context-title-row">
            <span class="context-icon"><i :class="area.icon" /></span>
            <div>
              <div class="title-line">
                <h2>{{ area.label }}</h2>
                <span
                  v-if="returnPath"
                  class="scope-chip"
                  title="These settings apply to the whole appliance, not only the network you came from."
                >
                  <i class="pi pi-globe" /> Appliance-wide
                </span>
              </div>
              <p>{{ area.blurb }}</p>
            </div>
          </div>
        </header>

        <div
          v-if="subtabs.length > 1"
          class="view-tabs"
          role="tablist"
          :aria-label="`${area.label} sections`"
          @keydown="handleTabKeydown"
        >
          <button
            v-for="(section, index) in subtabs"
            :id="`settings-tab-${area.id}-${section.id}`"
            :key="section.id"
            role="tab"
            :aria-selected="section.id === activeSecId"
            :aria-controls="`settings-panel-${area.id}`"
            :tabindex="section.id === activeSecId ? 0 : -1"
            :class="{ active: section.id === activeSecId }"
            :data-track="section.dataTrack"
            :data-index="index"
            @click="emitSec(section.id)"
          >
            {{ section.label }}
          </button>
        </div>

        <section
          :id="`settings-panel-${area.id}`"
          class="settings-panel"
          :class="{ fill: activeSubtab?.fill }"
          role="tabpanel"
          :aria-labelledby="
            subtabs.length > 1 ? `settings-tab-${area.id}-${activeSecId}` : undefined
          "
        >
          <keep-alive>
            <component
              :is="activeSubtab.component"
              v-if="activeSubtab && activeSubtab.keepAlive"
              :key="`${area.id}:${activeSecId}`"
            />
          </keep-alive>
          <component
            :is="activeSubtab.component"
            v-if="activeSubtab && !activeSubtab.keepAlive"
            :key="`${area.id}:${activeSecId}`"
          />
        </section>
      </section>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SETTINGS_AREAS, SETTINGS_GROUPS, findArea } from '../../config/settingsAreas.js';
import { safeInternalPath } from '../../utils/landing.js';

// P7 settings shell (section 10). The catalog in settingsAreas.js is the
// single source: areas become explorer rows, sections become a real tablist,
// and each section's existing editor mounts unchanged in the work surface, so
// every current function and deep link (?area=&sec=&return=) is retained by
// construction. Restyling the leaves is the per-package S-* work.
const route = useRoute();
const router = useRouter();

const DEFAULT_AREA_ID = SETTINGS_AREAS[0].id;
const area = computed(() => {
  const requested = route.query.area;
  return (requested && findArea(requested)) || findArea(DEFAULT_AREA_ID);
});
const subtabs = computed(() => area.value.subtabs);
const activeSecId = computed(() => {
  const ids = subtabs.value.map((section) => section.id);
  return ids.includes(route.query.sec) ? route.query.sec : ids[0] || '';
});
const activeSubtab = computed(
  () => subtabs.value.find((section) => section.id === activeSecId.value) || null,
);
const returnPath = computed(() => safeInternalPath(router, route.query.return));

function queryWithReturn(query) {
  return returnPath.value ? { ...query, return: returnPath.value } : query;
}
function emitArea(id) {
  router.push({ query: queryWithReturn({ area: id }) });
}
function emitSec(id) {
  router.push({ query: queryWithReturn({ area: area.value.id, sec: id }) });
}

// The section tablist takes ArrowLeft/ArrowRight, Home and End (T-38 rules).
function handleTabKeydown(event) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
  if (!(event.key in keys)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
  const current = tabs.indexOf(event.target);
  if (current < 0) return;
  event.preventDefault();
  const step = keys[event.key];
  const next =
    step === 'first'
      ? 0
      : step === 'last'
        ? tabs.length - 1
        : (current + step + tabs.length) % tabs.length;
  tabs[next].focus();
  emitSec(subtabs.value[next].id);
}

// Same legacy ?tab= translation the current shell does, so old bookmarks land.
const LEGACY_TAB = {
  updates: { area: 'maintenance', sec: 'updates' },
  backup: { area: 'maintenance', sec: 'backup' },
  certificates: { area: 'access', sec: 'certificate' },
  logging: { area: 'maintenance', sec: 'logs' },
  import: { area: 'maintenance', sec: 'import' },
};
onMounted(() => {
  const legacy = typeof route.query.tab === 'string' ? LEGACY_TAB[route.query.tab] : null;
  if (legacy) router.replace({ query: queryWithReturn(legacy) });
});

// Explorer search matches the area label, its blurb and its section labels,
// the same three things the current rail matches.
const search = ref('');
function areaMatches(entry, needle) {
  if (!needle) return true;
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.blurb.toLowerCase().includes(needle) ||
    entry.subtabs.some((section) => section.label.toLowerCase().includes(needle))
  );
}
function areasInGroup(group) {
  const needle = search.value.trim().toLowerCase();
  return SETTINGS_AREAS.filter((entry) => entry.group === group && areaMatches(entry, needle));
}
const visibleGroups = computed(() =>
  SETTINGS_GROUPS.filter((group) => areasInGroup(group).length > 0),
);
</script>

<style scoped>
/* Tokens duplicated from networks-workspace/workspace.css (section 5: a third
   consumer moves them to components/workspace/). */
.workspace-preview {
  --preview-accent: var(--cid-primary-color);
  --preview-accent-soft: color-mix(in srgb, var(--preview-accent) 12%, transparent);
  --preview-line: color-mix(in srgb, var(--cid-surface-border) 82%, transparent);
  --preview-muted: var(--cid-text-muted-color);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 100%;
  padding: 1.1rem;
  color: var(--cid-text-color);
  background:
    radial-gradient(
      circle at 7% 65%,
      color-mix(in srgb, var(--preview-accent) 8%, transparent),
      transparent 24rem
    ),
    var(--cid-surface-ground);
}
button,
input {
  font: inherit;
  color: inherit;
}
.workspace-frame {
  display: grid;
  grid-template-columns: 275px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--cid-surface-card);
  border: 1px solid var(--preview-line);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.1);
}
.explorer {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-height: 0;
  padding: 0.85rem 0.6rem;
  overflow: auto;
  border-right: 1px solid var(--preview-line);
  background: color-mix(in srgb, var(--cid-surface-ground) 52%, var(--cid-surface-card));
}
.explorer-search {
  position: relative;
  margin: 0 0.15rem 0.5rem;
}
.explorer-search i {
  position: absolute;
  left: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.72rem;
  color: var(--preview-muted);
  pointer-events: none;
}
.explorer-search input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.42rem 0.6rem 0.42rem 1.75rem;
  border: 1px solid var(--preview-line);
  border-radius: 8px;
  background: var(--cid-surface-card);
  font-size: var(--app-fs-sm);
}
.explorer-search input:focus {
  outline: none;
  border-color: var(--preview-accent);
}
.eyebrow {
  margin: 0.7rem 0.55rem 0.2rem;
  color: var(--preview-muted);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.area-row {
  display: grid;
  grid-template-columns: 1.1rem 1fr auto;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.55rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.area-row:hover,
.area-row.active {
  background: var(--cid-surface-card);
  box-shadow: inset 0 0 0 1px var(--preview-line);
}
.area-row.active {
  box-shadow:
    inset 3px 0 var(--preview-accent),
    inset 0 0 0 1px var(--preview-line);
}
.area-row > i {
  color: var(--preview-accent);
  font-size: 0.85rem;
}
.area-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.area-copy strong {
  font-size: var(--app-fs-sm);
}
.area-copy small {
  color: var(--preview-muted);
  font-size: var(--app-fs-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.area-count {
  padding: 0.08rem 0.38rem;
  border-radius: 999px;
  background: var(--cid-surface-200);
  color: var(--preview-muted);
  font-size: 0.62rem;
  font-weight: 700;
}
.explorer-empty {
  margin: 0.4rem 0.6rem;
  color: var(--preview-muted);
  font-size: var(--app-fs-xs);
}

.work-surface {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.context-header {
  padding: 0.9rem 1.1rem 0.7rem;
  border-bottom: 1px solid var(--preview-line);
}
.context-breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.45rem;
  color: var(--preview-muted);
  font-size: var(--app-fs-xs);
}
.context-breadcrumb i {
  font-size: 0.55rem;
}
.return-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
  color: var(--preview-accent);
  font-weight: 700;
  text-decoration: none;
}
.context-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.context-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 12px;
  background: var(--preview-accent-soft);
  color: var(--preview-accent);
}
.title-line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.title-line h2 {
  margin: 0;
  font-size: 1.2rem;
  letter-spacing: -0.02em;
}
.context-title-row p {
  margin: 0.1rem 0 0;
  color: var(--preview-muted);
  font-size: var(--app-fs-sm);
}
.scope-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  background: var(--preview-accent-soft);
  color: var(--preview-accent);
  font-size: var(--app-fs-xs);
  font-weight: 700;
}
.view-tabs {
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 0.18rem;
  padding: 0.48rem 0.75rem 0;
  background: color-mix(in srgb, var(--cid-surface-ground) 52%, var(--cid-surface-card));
  border-bottom: 1px solid var(--preview-line);
}
.view-tabs button {
  padding: 0.5rem 0.68rem 0.56rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--preview-muted);
  font-size: var(--app-fs-sm);
  font-weight: 700;
  cursor: pointer;
}
.view-tabs button.active {
  border-bottom-color: var(--preview-accent);
  color: var(--preview-accent);
}
.view-tabs button:focus-visible {
  outline: 2px solid var(--preview-accent);
  outline-offset: -2px;
  border-radius: 6px;
}
/* Same contract as the current shell's .sa-panel: a plain scroll container.
   Fill editors (height: 100% roots with their own scrolling table) get
   clipped so only that table scrolls. */
.settings-panel {
  flex: 1;
  min-height: 0;
  padding: 1rem 1.1rem;
  overflow: auto;
}
.settings-panel.fill {
  overflow: hidden;
}

/* Stacked below 1024px: the explorer sits above the work surface, so the
   frame scrolls the page instead of clipping the editor under it, and a fill
   editor keeps enough height to show its table or empty state. */
@media (max-width: 1023px) {
  .workspace-preview {
    height: auto;
  }
  .workspace-frame {
    grid-template-columns: minmax(0, 1fr);
    overflow: visible;
  }
  .explorer {
    max-height: 16rem;
    border-right: 0;
    border-bottom: 1px solid var(--preview-line);
  }
  .work-surface {
    overflow: visible;
  }
  .settings-panel,
  .settings-panel.fill {
    min-height: 32rem;
    overflow: visible;
  }
}
@media (max-width: 720px) {
  .workspace-preview {
    padding: 0.6rem;
  }
  .settings-panel {
    padding: 0.75rem 0.6rem;
  }
}
</style>
