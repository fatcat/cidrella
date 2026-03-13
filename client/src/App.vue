<template>
  <Toast successIcon="pi pi-check" infoIcon="pi pi-info" warnIcon="pi pi-exclamation-circle" errorIcon="pi pi-ban" />
  <router-view />
</template>

<script setup>
import Toast from 'primevue/toast';
</script>

<style>
body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  margin: 0;
}

/*
 * Custom surface hierarchy variables.
 * PrimeVue v4 Aura does NOT define --p-surface-ground, --p-surface-card,
 * or --p-surface-border. We define them here using PrimeVue's numbered
 * surface palette tokens (--p-surface-0 through --p-surface-950).
 *
 * Hierarchy (light): ground (gray-100) < card (white) < content (white)
 * Hierarchy (dark):  ground (darkest-950) < card (dark-900) < content (dark-800)
 */
:root {
  --p-surface-ground: var(--p-surface-100);
  --p-surface-card: var(--p-surface-0);
  --p-surface-border: var(--p-surface-200);
}
.p-dark {
  --p-surface-ground: var(--p-surface-950);
  --p-surface-card: var(--p-surface-800);
  --p-surface-border: var(--p-surface-700);
}

/* Monospace font for all DataTable body cells; headers stay sans-serif */
.p-datatable .p-datatable-tbody > tr > td {
  font-family: monospace;
}


/* Compact action buttons inside DataTable rows to reduce row height */
.p-datatable .p-datatable-tbody .p-button {
  width: 1.5rem !important;
  height: 1.5rem !important;
  min-width: 1.5rem !important;
  min-height: 1.5rem !important;
  padding: 0 !important;
  font-size: 0.75rem !important;
  line-height: 1 !important;
}
.p-datatable .p-datatable-tbody .p-button .p-button-icon {
  font-size: 0.75rem !important;
}
.p-datatable .p-datatable-tbody > tr > td {
  padding-top: 0.25rem !important;
  padding-bottom: 0.25rem !important;
}
.p-datatable .action-buttons {
  display: flex;
  gap: 0.25rem;
  align-items: center;
  line-height: 1;
}

/* Fix PrimeVue TabView ink bar sizing incorrectly on initial mount */
.p-tabview-ink-bar {
  display: none !important;
}
.p-tabview-tablist-item-active > .p-tabview-tab-header {
  border-bottom-color: var(--p-primary-color) !important;
}

/* Uniform toast style: dark background, light text */
.p-toast-message {
  background: var(--p-surface-700) !important;
  border: none !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
}
.p-toast-message-text,
.p-toast-summary,
.p-toast-detail {
  color: var(--p-surface-0) !important;
}
.p-toast-close-button {
  color: var(--p-surface-300) !important;
}
/* Circular icon backgrounds — white icon on colored circle */
.p-toast-message-icon {
  color: var(--p-surface-0) !important;
  width: 1.75rem !important;
  height: 1.75rem !important;
  min-width: 1.75rem !important;
  border-radius: 50% !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  font-size: 0.9rem !important;
}
.p-toast-message-success .p-toast-message-icon {
  background: var(--p-green-500) !important;
}
.p-toast-message-info .p-toast-message-icon {
  background: var(--p-blue-500) !important;
}
.p-toast-message-warn .p-toast-message-icon {
  background: var(--p-yellow-500) !important;
}
.p-toast-message-error .p-toast-message-icon {
  background: var(--p-red-500) !important;
}

/* ── Global badge utility classes ── */
.badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; display: inline-block; }
.badge-sm { font-size: 0.7rem; padding: 0.1rem 0.4rem; }

.badge-green   { background: color-mix(in srgb, var(--p-green-500) 20%, transparent);  color: var(--p-green-500); }
.badge-red     { background: color-mix(in srgb, var(--p-red-500) 20%, transparent);    color: var(--p-red-500); }
.badge-blue    { background: color-mix(in srgb, var(--p-blue-500) 20%, transparent);   color: var(--p-blue-500); }
.badge-yellow  { background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); }
.badge-orange  { background: color-mix(in srgb, var(--p-orange-500) 20%, transparent); color: var(--p-orange-500); }
.badge-indigo  { background: color-mix(in srgb, var(--p-indigo-500) 20%, transparent); color: var(--p-indigo-500); }
.badge-purple  { background: color-mix(in srgb, var(--p-purple-500) 20%, transparent); color: var(--p-purple-500); }
.badge-muted   { background: color-mix(in srgb, var(--p-surface-500) 15%, transparent); color: var(--p-text-muted-color); }
.badge-primary { background: color-mix(in srgb, var(--p-primary-color) 20%, transparent); color: var(--p-primary-color); }

.badge-green-light  { background: color-mix(in srgb, var(--p-green-500) 15%, transparent);  color: var(--p-green-500); }
.badge-red-light    { background: color-mix(in srgb, var(--p-red-500) 15%, transparent);    color: var(--p-red-500); }
.badge-yellow-light { background: color-mix(in srgb, var(--p-yellow-500) 15%, transparent); color: var(--p-yellow-500); }
.badge-blue-light   { background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);   color: var(--p-blue-500); }

/* Shared active menubar item styling */
.menubar-active-item {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  color: var(--p-primary-color);
  font-weight: 600;
}
</style>
