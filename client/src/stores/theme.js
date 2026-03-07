import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

// Each theme: { id, name, group: 'light'|'dark', primary, surface, preset }
// primary = Tailwind color name used for primary palette
// surface = Tailwind color name used for surface palette (neutral tones)
// Custom themes can use customPrimary/customSurface with raw hex palettes
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

  // ── Custom Themes ──
  {
    id: 'dark-nord', name: 'Nord', group: 'dark',
    customPrimary: {
      50:  '#f0f4f8', 100: '#dae5f0', 200: '#b8cfe0',
      300: '#88c0d0', 400: '#81a1c1', 500: '#5e81ac',
      600: '#4e6d91', 700: '#3f5876', 800: '#31445c',
      900: '#2e3440', 950: '#242933',
    },
    customSurface: {
      0:   '#eceff4', 50:  '#e5e9f0', 100: '#d8dee9',
      200: '#c2c9d6', 300: '#8891a1', 400: '#6d7a8c',
      500: '#4c566a', 600: '#434c5e', 700: '#3b4252',
      800: '#2e3440', 900: '#272c36', 950: '#21252e',
    },
    customIpam: { ground: '#21252e', card: '#2e3440' },
  },
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
  nord: '#88c0d0',
};

export const useThemeStore = defineStore('theme', () => {
  const currentThemeId = ref(localStorage.getItem('ipam-theme') || 'dark-emerald-zinc');

  const currentTheme = computed(() => themes.find(t => t.id === currentThemeId.value) || themes[0]);

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
