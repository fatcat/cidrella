import { computed, ref } from 'vue';
import { loadJson, saveJson } from '../utils/storage.js';

// The per-browser small-text size bump that lives in the header's user menu
// and is read by every workspace page. A module-level ref so the header and
// the pages share one value without a store.

const FONT_KEY = 'cidrella_workspace_font_bump';
const FONT_MAX = 2;

function clampBump(value) {
  return Math.min(FONT_MAX, Math.max(0, Number(value) || 0));
}

const fontBump = ref(clampBump(loadJson(FONT_KEY, 1)));

export function useWorkspaceFontBump() {
  const label = computed(() => (fontBump.value ? `+${fontBump.value} pt` : 'Default'));
  // Points to pixels for the CSS variable the workspace pages set on their root.
  const styleValue = computed(() => `${fontBump.value * 1.333}px`);
  function resize(delta) {
    fontBump.value = clampBump(fontBump.value + delta);
    saveJson(FONT_KEY, fontBump.value);
  }
  return { fontBump, label, styleValue, resize, max: FONT_MAX };
}

// Since the P10 cutover the workspaces are the interface. The classic views
// stay at these routes, reached from the user menu, until they are removed.
// There is no interface preference any more.
export const CLASSIC_PATHS = Object.freeze({
  networks: '/networks-classic',
  settings: '/system-classic',
  anomalies: '/anomalies-classic',
});
