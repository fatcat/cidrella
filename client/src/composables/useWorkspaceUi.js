import { computed, ref } from 'vue';
import { loadJson, saveJson } from '../utils/storage.js';

// Two per-browser workspace preferences that live in the header's user menu
// and are read by every workspace page: the small-text size bump and which
// interface the navigation opens. Module-level refs so the header and the
// pages share one value without a store.

const FONT_KEY = 'cidrella_workspace_font_bump';
const FONT_MAX = 2;
const INTERFACE_KEY = 'cidrella_interface';

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

// Pages that exist in both interfaces, current path first.
export const INTERFACE_PAIRS = [
  ['/networks', '/networks-preview'],
  ['/system', '/system-preview'],
];

const interfacePreference = ref(
  loadJson(INTERFACE_KEY, 'current') === 'workspace' ? 'workspace' : 'current',
);

export function useInterfacePreference() {
  function setPreference(value) {
    interfacePreference.value = value === 'workspace' ? 'workspace' : 'current';
    saveJson(INTERFACE_KEY, interfacePreference.value);
  }
  // The path a navigation link should open for a current-interface page.
  function preferredPath(currentPath) {
    const pair = INTERFACE_PAIRS.find(([current]) => current === currentPath);
    return pair && interfacePreference.value === 'workspace' ? pair[1] : currentPath;
  }
  // The same page in the other interface, or null when it has no counterpart.
  function counterpart(path, target = interfacePreference.value) {
    const pair = INTERFACE_PAIRS.find(
      ([current, workspace]) => path === current || path === workspace,
    );
    if (!pair) return null;
    const next = target === 'workspace' ? pair[1] : pair[0];
    return next === path ? null : next;
  }
  return { interfacePreference, setPreference, preferredPath, counterpart };
}
