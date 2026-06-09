<!-- Appearance / theme picker. Extracted from System.vue tab 10 (1:1). -->
<template>
  <div class="themes-page">
    <p class="field-help" style="margin-bottom: 1.25rem">Choose a color theme. The active theme is highlighted.</p>

    <div v-for="group in themeGroups" :key="group.label" class="theme-group">
      <h3>{{ group.label }}</h3>
      <div class="theme-card-grid">
        <div v-for="t in group.themes" :key="t.id"
             class="theme-card" :class="{ 'theme-active': themeStore.currentThemeId === t.id }"
             @click="themeStore.applyTheme(t.id)">
          <span class="theme-swatch-dot" :style="{ background: getThemeSwatch(t) }"></span>
          <div class="theme-card-info">
            <span class="theme-card-name">{{ getThemeLabel(t) }}</span>
            <span class="theme-card-desc">{{ getThemeDesc(t) }}</span>
          </div>
          <i v-if="themeStore.currentThemeId === t.id" class="pi pi-check theme-check"></i>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useThemeStore, themes, colorSwatches } from '../../stores/theme.js';

const themeStore = useThemeStore();

const themeGroups = [
  { label: 'Curated Themes', themes: themes.filter(t => t.tier === 'curated') },
  { label: 'Experimental Themes', themes: themes.filter(t => t.tier === 'experimental') },
];

function getThemeSwatch(t) {
  if (t.primary) return colorSwatches[t.primary];
  const nameKey = t.name.toLowerCase();
  const scopedKey = `${nameKey} ${t.group}`;
  return colorSwatches[scopedKey] || colorSwatches[nameKey] || t.customPrimary?.[300] || '#888';
}
function getThemeDesc(t) {
  if (t.primary) return `${t.primary} primary, ${t.surface} surface`;
  return 'custom palette';
}
function getThemeLabel(t) {
  return `${t.name} (${t.group})`;
}
</script>

<style scoped>
.themes-page h3 { margin: 0 0 0.75rem 0; }
.theme-group { margin-bottom: 1.5rem; }
.theme-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
.theme-card { display: flex; align-items: center; gap: 0.65rem; padding: 0.6rem 0.75rem;
  border: 2px solid var(--p-surface-border); border-radius: 8px; cursor: pointer; transition: all 0.15s; }
.theme-card:hover { background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  border-color: color-mix(in srgb, var(--p-primary-color) 40%, transparent); }
.theme-card.theme-active { border-color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent); }
.theme-swatch-dot { width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(255, 255, 255, 0.15); }
.theme-card-info { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.theme-card-name { font-weight: 600; font-size: var(--app-fs-sm); }
.theme-card-desc { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); }
.theme-check { color: var(--p-primary-color); font-size: var(--app-fs-md); flex-shrink: 0; }
.field-help { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); }
</style>
