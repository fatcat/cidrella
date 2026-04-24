import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

// Each theme: { id, name, group: 'light'|'dark', customPrimary, customSurface }
//
// Five palette families, each providing both a light and dark variant
// that share the SAME customPrimary + customSurface — PrimeVue Aura picks
// different shade indices based on the .p-dark class, so one palette
// naturally serves both modes.
//
// The palettes are inspired by their namesake editor/design themes
// (Catppuccin, Rosé Pine, Gruvbox, One, Nord) but the surface ramps have
// been tightened toward the "muted pastel on gray" aesthetic rather than
// the originals' near-white light bases. Light mode lands on medium gray
// with dark gray text; dark mode lands on charcoal with light gray text.
// Primary ramps keep each theme's signature accent (mauve, iris, aqua,
// blue, arctic blue respectively), with 300-400 as the pastel form used
// by the dark variant and 500-600 as the deeper form used by light mode.

const palettes = {
  // ── Catppuccin — cool gray + signature mauve accent
  //    Mocha bases (dark): base=#1e1e2e, surface0=#313244, surface1=#45475a,
  //                        surface2=#585b70, text=#cdd6f4
  //    Latte accent:       mauve=#8839ef   Mocha accent: mauve=#cba6f7
  catppuccin: {
    primary: {
      50:  '#f0eafb', 100: '#e1d5f7', 200: '#c8b1f0',
      300: '#cba6f7', 400: '#ad87e5', 500: '#8d67d1',
      600: '#7851b8', 700: '#5d3f92', 800: '#432e6c',
      900: '#2d1f49', 950: '#1a122c',
    },
    surface: {
      0:   '#d8d9df', 50:  '#cdced5', 100: '#c2c3cb',
      200: '#adafba', 300: '#9a9ba8', 400: '#878895',
      500: '#6c6d7c', 600: '#585b70', 700: '#45475a',
      800: '#313244', 900: '#1e1e2e', 950: '#11111b',
    },
  },

  // ── Rosé Pine — warm gray + signature iris (soft lavender) accent
  //    Main bases (dark):  base=#191724, surface=#1f1d2e, overlay=#26233a
  //    Dawn iris:          #907aa9    Main iris: #c4a7e7
  rosePine: {
    primary: {
      50:  '#f1ecf8', 100: '#e3d7f0', 200: '#d0b8e5',
      300: '#c4a7e7', 400: '#a889c6', 500: '#907aa9',
      600: '#786290', 700: '#604f74', 800: '#463955',
      900: '#30273e', 950: '#1a1426',
    },
    surface: {
      0:   '#ddd8d3', 50:  '#d1cbc6', 100: '#c4bfba',
      200: '#aba7a3', 300: '#928e8c', 400: '#797593',
      500: '#605a70', 600: '#524f67', 700: '#403d52',
      800: '#26233a', 900: '#1f1d2e', 950: '#191724',
    },
  },

  // ── Gruvbox — sepia warm gray + signature aqua accent (light + dark)
  //    Dark bases:  bg0=#282828, bg1=#3c3836, bg2=#504945, bg3=#665c54
  //    Dark aqua:   #8ec07c     Light aqua: #689d6a
  //    Light-mode surface shades (0–100) pulled toward medium warm-gray
  //    rather than canonical Gruvbox's near-white cream (#fbf1c7), so the
  //    light theme lands on the "medium gray bg, dark gray text" spec
  //    instead of "cream paper." Mid-to-dark shades (400–950) stay on
  //    canonical Gruvbox fg4→bg0-hard.
  gruvbox: {
    primary: {
      50:  '#e9f1e5', 100: '#d0e3c9', 200: '#afcfa4',
      300: '#8ec07c', 400: '#79ab65', 500: '#689d6a',
      600: '#527d54', 700: '#3e5e40', 800: '#2b422d',
      900: '#1b2a1c', 950: '#0e170f',
    },
    surface: {
      0:   '#cdc6b4', 50:  '#c1bba8', 100: '#b3ad9d',
      200: '#a59f90', 300: '#8c877b', 400: '#7c6f64',
      500: '#665c54', 600: '#504945', 700: '#3c3836',
      800: '#32302f', 900: '#282828', 950: '#1d2021',
    },
  },

  // ── Tokyo Day — light-gray blue + soft blue accent (LIGHT-ONLY)
  //    Tokyo Night Day bases: bg=#e1e2e7, bg_dark=#b7c1e3,
  //                           comment=#848cb5, dark3=#8990b3
  //    Day blue accent: #2e7de9   Night pastel form: #7aa2f7
  tokyoDay: {
    primary: {
      50:  '#e7efff', 100: '#c7d7fc', 200: '#9ebafa',
      300: '#7aa2f7', 400: '#5089f4', 500: '#2e7de9',
      600: '#1f60c0', 700: '#17488f', 800: '#0f305e',
      900: '#081e3c', 950: '#040f1d',
    },
    surface: {
      0:   '#d0d1d8', 50:  '#c4c8da', 100: '#b7c1e3',
      200: '#a0abd4', 300: '#8990b3', 400: '#848cb5',
      500: '#68709a', 600: '#4b5582', 700: '#3a4169',
      800: '#2a3050', 900: '#1a2037', 950: '#0d101f',
    },
  },

  // ── One — blue-gray + signature blue accent (Atom/VSCode One theme)
  //    Dark bases: bg=#282c34, lighter=#3e4451, gutter=#636d83
  //    Light blue: #4078f2    Dark blue: #61afef
  one: {
    primary: {
      50:  '#dfecfd', 100: '#b8d4fb', 200: '#86b6f7',
      300: '#61afef', 400: '#4d8ff4', 500: '#4078f2',
      600: '#2c5dd2', 700: '#1f46a5', 800: '#132f7a',
      900: '#0a1c50', 950: '#050e2b',
    },
    surface: {
      0:   '#c9cbd1', 50:  '#bcbec5', 100: '#afb2ba',
      200: '#9a9da8', 300: '#868996', 400: '#6f7381',
      500: '#5a5f6d', 600: '#4c5264', 700: '#3e4451',
      800: '#323842', 900: '#282c34', 950: '#1a1d23',
    },
  },

  // ── Starry Night (light) — green/earth palette from the painting
  //    Primary:  cypress & hills — muted sage/olive green
  //    Surface:  village cream-gray → rolling olive → cypress near-black
  //    Light bg (surface.0) ≈ #cbcaba medium warm-gray with a green cast
  //    Paired with starryNight (dark) below — the sky-side of the painting.
  starryNightLight: {
    primary: {
      50:  '#eaeddf', 100: '#d6dcc3', 200: '#b6c09d',
      300: '#9ba683', 400: '#818c6a', 500: '#697353',
      600: '#525a42', 700: '#3d4432', 800: '#2a3024',
      900: '#1a1e17', 950: '#0e110c',
    },
    surface: {
      0:   '#cbcaba', 50:  '#c0bfad', 100: '#b1b09e',
      200: '#96958a', 300: '#7f7f74', 400: '#686c5d',
      500: '#55584a', 600: '#44483b', 700: '#363a2f',
      800: '#2a2d25', 900: '#1d201a', 950: '#12140f',
    },
  },

  // ── Starry Night (dark) — Van Gogh (1889) sky palette
  //    Primary:  star yellow → golden moon (bright to deep ochre)
  //    Surface:  village cream → dusk blue-gray → cobalt night sky
  //    Dark bg  (surface.900) ≈ #13294a deep night-sky blue
  //    Paired with starryNightLight above — the earth-side of the painting.
  starryNight: {
    primary: {
      50:  '#556382', 100: '#556382', 200: '#556382',
      300: '#f7cc5a', 400: '#f4b73a', 500: '#e09b26',
      600: '#b67d1c', 700: '#8e6115', 800: '#624510',
      900: '#3e2c0b', 950: '#241a06',
    },
    surface: {
      0:   '#d5d0be', 50:  '#c9c4b0', 100: '#b8b39f',
      200: '#a19d8b', 300: '#898778', 400: '#6e7685',
      500: '#556382', 600: '#3f5278', 700: '#2d4166',
      800: '#1d3556', 900: '#13294a', 950: '#0b1e3c',
    },
  },

  // ── Nord — hand-tuned, preserved unchanged
  nord: {
    primary: {
      50:  '#f0f4f8', 100: '#dae5f0', 200: '#b8cfe0',
      300: '#88c0d0', 400: '#81a1c1', 500: '#5e81ac',
      600: '#4e6d91', 700: '#3f5876', 800: '#31445c',
      900: '#2e3440', 950: '#242933',
    },
    surface: {
      0:   '#eceff4', 50:  '#e5e9f0', 100: '#d8dee9',
      200: '#c2c9d6', 300: '#8891a1', 400: '#6d7a8c',
      500: '#4c566a', 600: '#434c5e', 700: '#3b4252',
      800: '#2e3440', 900: '#272c36', 950: '#21252e',
    },
  },
};

export const themes = [
  // ── Light ──
  { id: 'light-catppuccin', name: 'Catppuccin', group: 'light', customPrimary: palettes.catppuccin.primary, customSurface: palettes.catppuccin.surface },
  { id: 'light-rose-pine',  name: 'Rosé Pine',  group: 'light', customPrimary: palettes.rosePine.primary,   customSurface: palettes.rosePine.surface },
  { id: 'light-gruvbox',    name: 'Gruvbox',    group: 'light', customPrimary: palettes.gruvbox.primary,    customSurface: palettes.gruvbox.surface },
  { id: 'light-one',        name: 'One',        group: 'light', customPrimary: palettes.one.primary,        customSurface: palettes.one.surface },
  { id: 'light-starry-night', name: 'Starry Night', group: 'light', customPrimary: palettes.starryNightLight.primary, customSurface: palettes.starryNightLight.surface },
  { id: 'light-tokyo-day',  name: 'Tokyo Day',  group: 'light', customPrimary: palettes.tokyoDay.primary,   customSurface: palettes.tokyoDay.surface },

  // ── Dark ──
  { id: 'dark-catppuccin',  name: 'Catppuccin', group: 'dark',  customPrimary: palettes.catppuccin.primary, customSurface: palettes.catppuccin.surface },
  { id: 'dark-rose-pine',   name: 'Rosé Pine',  group: 'dark',  customPrimary: palettes.rosePine.primary,   customSurface: palettes.rosePine.surface },
  { id: 'dark-gruvbox',     name: 'Gruvbox',    group: 'dark',  customPrimary: palettes.gruvbox.primary,    customSurface: palettes.gruvbox.surface },
  { id: 'dark-one',         name: 'One',        group: 'dark',  customPrimary: palettes.one.primary,        customSurface: palettes.one.surface },
  { id: 'dark-starry-night', name: 'Starry Night', group: 'dark', customPrimary: palettes.starryNight.primary, customSurface: palettes.starryNight.surface },
  { id: 'dark-nord',        name: 'Nord',       group: 'dark',  customPrimary: palettes.nord.primary,       customSurface: palettes.nord.surface },
];

// Preview swatches for the Themes picker — each uses the palette's
// signature accent shade at 300 (the pastel form seen in dark mode) so
// the swatch reads as the theme's personality on both light and dark
// picker cards.
export const colorSwatches = {
  catppuccin:  palettes.catppuccin.primary[300],
  'rosé pine': palettes.rosePine.primary[300],
  gruvbox:     palettes.gruvbox.primary[300],
  one:         palettes.one.primary[300],
  'tokyo day': palettes.tokyoDay.primary[300],
  // Starry Night has two distinct palettes — green for light, yellow for
  // dark — so the picker needs two swatches, not one shared by name.
  // System.vue branches on theme.group to pick the right key.
  'starry night light': palettes.starryNightLight.primary[300],
  'starry night':       palettes.starryNight.primary[300],
  nord:        palettes.nord.primary[300],
};

export const useThemeStore = defineStore('theme', () => {
  // Default to Nord — the only theme preserved across the v0.4.15 rework.
  // Previously-stored theme IDs (light-emerald-slate, dark-blue-zinc,
  // light-sage etc.) no longer exist; they fall through to Nord via the
  // currentTheme computed and init() snaps the stored ID on next boot.
  const currentThemeId = ref(localStorage.getItem('cidrella-theme') || 'dark-nord');

  const currentTheme = computed(() =>
    themes.find(t => t.id === currentThemeId.value) ||
    themes.find(t => t.id === 'dark-nord') ||
    themes[0]
  );

  function applyTheme(themeId) {
    const theme = themes.find(t => t.id === themeId);
    if (!theme) return;

    currentThemeId.value = themeId;
    localStorage.setItem('cidrella-theme', themeId);

    if (theme.group === 'dark') {
      document.documentElement.classList.add('p-dark');
    } else {
      document.documentElement.classList.remove('p-dark');
    }

    window.dispatchEvent(new CustomEvent('ipam:theme-change', { detail: theme }));
  }

  function init() {
    if (!themes.find(t => t.id === currentThemeId.value)) {
      currentThemeId.value = currentTheme.value.id;
    }
    applyTheme(currentThemeId.value);
  }

  return { currentThemeId, currentTheme, applyTheme, init, themes };
});
