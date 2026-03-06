import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

// Each theme: { id, name, group: 'light'|'dark', primary, surface, preset }
// primary = Tailwind color name used for primary palette
// surface = Tailwind color name used for surface palette (neutral tones)
export const themes = [
  // ── Light Themes ──
  { id: 'light-emerald-slate',   name: 'Emerald',      group: 'light', primary: 'emerald', surface: 'slate' },
  { id: 'light-blue-slate',      name: 'Ocean Blue',    group: 'light', primary: 'blue',    surface: 'slate' },
  { id: 'light-indigo-slate',    name: 'Indigo',        group: 'light', primary: 'indigo',  surface: 'slate' },
  { id: 'light-violet-gray',     name: 'Violet',        group: 'light', primary: 'violet',  surface: 'gray' },
  { id: 'light-purple-gray',     name: 'Purple',        group: 'light', primary: 'purple',  surface: 'gray' },
  { id: 'light-sky-slate',       name: 'Sky',           group: 'light', primary: 'sky',     surface: 'slate' },
  { id: 'light-cyan-slate',      name: 'Cyan',          group: 'light', primary: 'cyan',    surface: 'slate' },
  { id: 'light-teal-slate',      name: 'Teal',          group: 'light', primary: 'teal',    surface: 'slate' },
  { id: 'light-green-neutral',   name: 'Green',         group: 'light', primary: 'green',   surface: 'neutral' },
  { id: 'light-amber-stone',     name: 'Amber',         group: 'light', primary: 'amber',   surface: 'stone' },
  { id: 'light-orange-stone',    name: 'Orange',        group: 'light', primary: 'orange',  surface: 'stone' },
  { id: 'light-rose-gray',       name: 'Rose',          group: 'light', primary: 'rose',    surface: 'gray' },

  // ── Dark Themes ──
  { id: 'dark-emerald-zinc',     name: 'Emerald',       group: 'dark', primary: 'emerald', surface: 'zinc' },
  { id: 'dark-blue-zinc',        name: 'Ocean Blue',    group: 'dark', primary: 'blue',    surface: 'zinc' },
  { id: 'dark-indigo-zinc',      name: 'Indigo',        group: 'dark', primary: 'indigo',  surface: 'zinc' },
  { id: 'dark-violet-zinc',      name: 'Violet',        group: 'dark', primary: 'violet',  surface: 'zinc' },
  { id: 'dark-purple-neutral',   name: 'Purple',        group: 'dark', primary: 'purple',  surface: 'neutral' },
  { id: 'dark-sky-slate',        name: 'Sky',           group: 'dark', primary: 'sky',     surface: 'slate' },
  { id: 'dark-cyan-slate',       name: 'Cyan',          group: 'dark', primary: 'cyan',    surface: 'slate' },
  { id: 'dark-teal-zinc',        name: 'Teal',          group: 'dark', primary: 'teal',    surface: 'zinc' },
  { id: 'dark-green-neutral',    name: 'Green',         group: 'dark', primary: 'green',   surface: 'neutral' },
  { id: 'dark-amber-neutral',    name: 'Amber',         group: 'dark', primary: 'amber',   surface: 'neutral' },
  { id: 'dark-orange-neutral',   name: 'Orange',        group: 'dark', primary: 'orange',  surface: 'neutral' },
  { id: 'dark-rose-zinc',        name: 'Rose',          group: 'dark', primary: 'rose',    surface: 'zinc' },
];

// Color swatches for preview (500-level shade)
export const colorSwatches = {
  emerald: '#10b981',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  sky: '#0ea5e9',
  cyan: '#06b6d4',
  teal: '#14b8a6',
  green: '#22c55e',
  amber: '#f59e0b',
  orange: '#f97316',
  rose: '#f43f5e',
};

export const useThemeStore = defineStore('theme', () => {
  const currentThemeId = ref(localStorage.getItem('ipam-theme') || 'dark-emerald-zinc');

  const currentTheme = () => themes.find(t => t.id === currentThemeId.value) || themes[0];

  function applyTheme(themeId) {
    const theme = themes.find(t => t.id === themeId);
    if (!theme) return;

    currentThemeId.value = themeId;
    localStorage.setItem('ipam-theme', themeId);

    // Toggle dark mode class
    if (theme.group === 'dark') {
      document.documentElement.classList.add('p-dark');
    } else {
      document.documentElement.classList.remove('p-dark');
    }

    // Apply primary and surface colors via PrimeVue's updatePreset
    // We dispatch a custom event that main.js listens to
    window.dispatchEvent(new CustomEvent('ipam:theme-change', { detail: theme }));
  }

  function init() {
    applyTheme(currentThemeId.value);
  }

  return { currentThemeId, currentTheme, applyTheme, init, themes };
});
