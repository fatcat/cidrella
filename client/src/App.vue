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
 * Hierarchy (dark):  ground (zinc-950) < card (zinc-900) < content (zinc-800)
 *                    darkest → lightest, i.e. more ink = higher elevation.
 */
:root {
  --p-surface-ground: var(--p-surface-100);
  --p-surface-card: var(--p-surface-0);
  --p-surface-content: var(--p-surface-0);
  --p-surface-border: var(--p-surface-200);

  /* App type scale — dense by design. Pixel-based so they don't compound
     with browser font-size adjustments; rem-based spacing still scales. */
  --app-fs-xs:   11px;  /* uppercase eyebrows, version tags */
  --app-fs-sm:   12px;  /* meta strips, chips, tree sub-labels */
  --app-fs-base: 14px;  /* body, table cells */
  --app-fs-md:   15px;  /* h4, tree item primary */
  --app-fs-lg:   17px;  /* h3, section titles */
  --app-fs-xl:   20px;  /* page h2 */
  --app-fs-2xl:  24px;  /* hero stats */
  --app-fs-3xl:  30px;  /* KPI numerals */

  /* App spacing scale — 4px rhythm. Use these as literals. */
  --sp-1:  4px;
  --sp-2:  8px;
  --sp-3:  12px;
  --sp-4:  16px;
  --sp-6:  24px;
  --sp-8:  32px;
  --sp-10: 40px;
}
.p-dark {
  --p-surface-ground: var(--p-surface-950);
  --p-surface-card: var(--p-surface-900);
  --p-surface-content: var(--p-surface-800);
  --p-surface-border: var(--p-surface-700);
}

/* DataTable row height unified to 36px with 14px monospace body. */
.p-datatable .p-datatable-tbody > tr > td {
  font-family: monospace;
  font-size: var(--app-fs-base);
  padding: 9px 12px;
  line-height: 1.3;
}
.p-datatable .p-datatable-thead > tr > th {
  padding: 10px 12px;
  font-size: var(--app-fs-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* Compact action buttons inside DataTable rows fit the 36px row. */
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

/* Muted cell text - for placeholders and non-highlighted dense-table text. */
.cell-muted {
  color: var(--p-text-muted-color);
  font-family: monospace;
  font-size: var(--app-fs-base);
}

.ip-mono {
  font-family: monospace;
  font-size: var(--app-fs-base);
}

/* Taxonomy tag — tinted capsule for *categorical* flags only
   (Reservation, Gateway, Rogue, System, etc.). Never for state.
   Spec §3.4: primary-color tint, xs size, 4px radius, 2/6px padding. */
.taxonomy-tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-sans, inherit);
  font-size: var(--app-fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
  white-space: nowrap;
  background: color-mix(in srgb, var(--p-primary-color) 18%, transparent);
  color: var(--p-primary-color);
}
.taxonomy-tag.taxonomy-warn   { background: color-mix(in srgb, var(--p-orange-500) 16%, transparent); color: var(--p-orange-500); }
.taxonomy-tag.taxonomy-err    { background: color-mix(in srgb, var(--p-red-500) 16%, transparent);    color: var(--p-red-500); }
.taxonomy-tag.taxonomy-info   { background: color-mix(in srgb, var(--p-blue-500) 16%, transparent);   color: var(--p-blue-500); }
.taxonomy-tag.taxonomy-muted  { background: color-mix(in srgb, var(--p-surface-500) 16%, transparent); color: var(--p-text-muted-color); }

.address-type-pill {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-sans, inherit);
  font-size: var(--app-fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
  white-space: nowrap;
}
.address-type-pill.type-static-dns {
  background: color-mix(in srgb, var(--p-blue-500) 16%, transparent);
  color: var(--p-blue-500);
}
.address-type-pill.type-dynamic-dhcp {
  background: color-mix(in srgb, var(--p-green-500) 16%, transparent);
  color: var(--p-green-500);
}
.address-type-pill.type-reserved-dhcp {
  background: color-mix(in srgb, var(--p-primary-color) 18%, transparent);
  color: var(--p-primary-color);
}
.address-type-pill.type-system {
  background: color-mix(in srgb, var(--p-surface-500) 16%, transparent);
  color: var(--p-text-muted-color);
}
.address-type-pill.type-gateway,
.address-type-pill.type-locked {
  background: color-mix(in srgb, var(--p-orange-500) 16%, transparent);
  color: var(--p-orange-500);
}
.address-type-pill.type-rogue {
  background: color-mix(in srgb, var(--p-red-500) 16%, transparent);
  color: var(--p-red-500);
}

/* Status text — for "state" values in dense data tables.
   Spec rule: capsules are for taxonomy, text is for state. */
.status-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: monospace;
  font-size: var(--app-fs-base);
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.status-text::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}
.status-text.state-err    { color: var(--p-red-500); }
.status-text.state-warn   { color: var(--p-orange-500); }
.status-text.state-ok     { color: var(--p-green-500); }
.status-text.state-info   { color: var(--p-blue-500); }
.status-text.state-muted  { color: var(--p-text-muted-color); }
/* "Off" variants use a ring instead of a filled dot — shape carries meaning
   even in grayscale, addressing color-alone contrast concerns. */
.status-text.state-muted::before {
  background: transparent;
  border: 1.5px solid currentColor;
  width: 7px; height: 7px;
}

/* Shared active menubar item styling */
.menubar-active-item {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  color: var(--p-primary-color);
  font-weight: 600;
}
</style>
