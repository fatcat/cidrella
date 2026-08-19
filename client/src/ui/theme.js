// The theming API behind the 13-theme system.
//
// `updatePreset` and `updateSurfacePalette` are called from main.js's
// `ipam:theme-change` listener; `BasePreset` is handed to the plugin at
// registration. stores/theme.js deliberately imports NONE of this: it emits a
// CustomEvent carrying plain hex ramps and knows nothing about the widget
// library, which is why the theme system costs almost nothing to move.
export { updatePreset, updateSurfacePalette } from '@primeuix/themes';
export { default as BasePreset } from '@primeuix/themes/aura';
