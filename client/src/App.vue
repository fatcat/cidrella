<template>
  <Toast successIcon="pi pi-check" infoIcon="pi pi-info" warnIcon="pi pi-exclamation-circle" errorIcon="pi pi-ban" />
  <router-view />
</template>

<script setup>
import Toast from './ui/Toast.js';
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

  /* App type scale, dense by design. Pixel-based so they don't compound
     with browser font-size adjustments; rem-based spacing still scales. */
  --app-fs-xs:   11px;  /* uppercase eyebrows, version tags */
  --app-fs-sm:   12px;  /* meta strips, chips, tree sub-labels */
  --app-fs-base: 14px;  /* body, table cells */
  --app-fs-md:   15px;  /* h4, tree item primary */
  --app-fs-lg:   17px;  /* h3, section titles */
  --app-fs-xl:   20px;  /* page h2 */
  --app-fs-2xl:  24px;  /* hero stats */
  --app-fs-3xl:  30px;  /* KPI numerals */

  /* App spacing scale, 4px rhythm. Use these as literals. */
  --sp-1:  4px;
  --sp-2:  8px;
  --sp-3:  12px;
  --sp-4:  16px;
  --sp-6:  24px;
  --sp-8:  32px;
  --sp-10: 40px;

  /* Semantic application colors. These intentionally sit above PrimeVue's
     theme palette so status, type, and chart meaning stays stable when the
     user changes visual themes. */
  --cid-static-dns: #1d4ed8;
  --cid-dynamic-dhcp: #166534;
  --cid-reserved-dhcp: #6d28d9;
  --cid-system: #475569;
  --cid-gateway: #b45309;
  --cid-reserved: #0f766e;
  --cid-rogue: #b91c1c;

  --cid-status-ok: #15803d;
  --cid-status-warn: #b45309;
  --cid-status-err: #b91c1c;
  --cid-status-info: #1d4ed8;
  --cid-status-muted: #64748b;

  --cid-chart-1: #2563eb;
  --cid-chart-2: #166534;
  --cid-chart-3: #9333ea;
  --cid-chart-4: #92400e;
  --cid-chart-5: #dc2626;
  --cid-chart-6: #0e7490;
  --cid-chart-7: #3730a3;
  --cid-chart-8: #be123c;
  --cid-chart-9: #3f6212;
  --cid-chart-10: #0f766e;
  --cid-chart-grid: rgba(51, 65, 85, 0.24);
  --cid-chart-text: #334155;
  --cid-chart-line-fill-alpha: 0.24;
  --cid-chart-line-width: 2.5;
  --cid-chart-doughnut-alpha: 0.62;
  --cid-gauge-track: rgba(100, 116, 139, 0.18);
}
.p-dark {
  --p-surface-ground: var(--p-surface-950);
  --p-surface-card: var(--p-surface-900);
  --p-surface-content: var(--p-surface-800);
  --p-surface-border: var(--p-surface-700);

  --cid-static-dns: #93c5fd;
  --cid-dynamic-dhcp: #86efac;
  --cid-reserved-dhcp: #c4b5fd;
  --cid-system: #94a3b8;
  --cid-gateway: #fbbf24;
  --cid-reserved: #5eead4;
  --cid-rogue: #f87171;

  --cid-status-ok: #86efac;
  --cid-status-warn: #fbbf24;
  --cid-status-err: #f87171;
  --cid-status-info: #93c5fd;
  --cid-status-muted: #94a3b8;

  --cid-chart-1: #93c5fd;
  --cid-chart-2: #86efac;
  --cid-chart-3: #c4b5fd;
  --cid-chart-4: #fbbf24;
  --cid-chart-5: #f87171;
  --cid-chart-6: #67e8f9;
  --cid-chart-7: #a5b4fc;
  --cid-chart-8: #f9a8d4;
  --cid-chart-9: #bef264;
  --cid-chart-10: #5eead4;
  --cid-chart-grid: rgba(148, 163, 184, 0.22);
  --cid-chart-text: #94a3b8;
  --cid-chart-line-fill-alpha: 0.22;
  --cid-chart-line-width: 2.25;
  --cid-chart-doughnut-alpha: 0.92;
  --cid-gauge-track: rgba(148, 163, 184, 0.18);
}

[data-cidrella-theme="light-one"] {
  --cid-chart-1: #1d4ed8;
  --cid-chart-2: #14532d;
  --cid-chart-3: #6d28d9;
  --cid-chart-4: #92400e;
  --cid-chart-5: #b91c1c;
  --cid-chart-6: #0e7490;
  --cid-chart-7: #3730a3;
  --cid-chart-8: #9f1239;
  --cid-chart-9: #3f6212;
  --cid-chart-10: #0f766e;
  --cid-chart-grid: rgba(39, 50, 68, 0.22);
  --cid-chart-text: #273244;
  --cid-chart-line-fill-alpha: 0.24;
  --cid-chart-line-width: 2.5;
  --cid-chart-doughnut-alpha: 0.68;
  --cid-gauge-track: rgba(39, 50, 68, 0.16);
}

[data-cidrella-theme="light-tokyo-day"] {
  --cid-chart-1: #1d4ed8;
  --cid-chart-2: #166534;
  --cid-chart-3: #6d28d9;
  --cid-chart-4: #92400e;
  --cid-chart-5: #b91c1c;
  --cid-chart-6: #0e7490;
  --cid-chart-7: #3730a3;
  --cid-chart-8: #9f1239;
  --cid-chart-9: #3f6212;
  --cid-chart-10: #0f766e;
  --cid-chart-grid: rgba(51, 65, 85, 0.24);
  --cid-chart-text: #334155;
  --cid-chart-line-fill-alpha: 0.24;
  --cid-chart-line-width: 2.5;
  --cid-chart-doughnut-alpha: 0.66;
  --cid-gauge-track: rgba(51, 65, 85, 0.16);
}

[data-cidrella-theme="light-catppuccin"] {
  --cid-chart-1: #1d4ed8;
  --cid-chart-2: #166534;
  --cid-chart-3: #7e22ce;
  --cid-chart-4: #92400e;
  --cid-chart-5: #b91c1c;
  --cid-chart-6: #0e7490;
  --cid-chart-7: #3730a3;
  --cid-chart-8: #9f1239;
  --cid-chart-9: #3f6212;
  --cid-chart-10: #0f766e;
  --cid-chart-grid: rgba(51, 65, 85, 0.22);
  --cid-chart-text: #374151;
  --cid-chart-line-fill-alpha: 0.24;
  --cid-chart-line-width: 2.5;
  --cid-chart-doughnut-alpha: 0.64;
  --cid-gauge-track: rgba(51, 65, 85, 0.16);
}

[data-cidrella-theme="dark-nord"] {
  --cid-static-dns: #88c0d0;
  --cid-dynamic-dhcp: #a3be8c;
  --cid-reserved-dhcp: #b48ead;
  --cid-system: #aeb7c6;
  --cid-gateway: #ebcb8b;
  --cid-reserved: #8fbcbb;
  --cid-rogue: #d8757f;
  --cid-status-ok: #a3be8c;
  --cid-status-warn: #ebcb8b;
  --cid-status-err: #d8757f;
  --cid-status-info: #88c0d0;
  --cid-status-muted: #8a94a6;
  --cid-chart-1: #88c0d0;
  --cid-chart-2: #a3be8c;
  --cid-chart-3: #b48ead;
  --cid-chart-4: #ebcb8b;
  --cid-chart-5: #d8757f;
  --cid-chart-6: #81a1c1;
  --cid-chart-7: #8fbcbb;
  --cid-chart-8: #d08770;
  --cid-chart-9: #7da0ce;
  --cid-chart-10: #aeb7c6;
  --cid-chart-grid: rgba(194, 201, 214, 0.16);
  --cid-chart-text: #c2c9d6;
  --cid-chart-line-fill-alpha: 0.22;
  --cid-chart-line-width: 2.25;
  --cid-chart-doughnut-alpha: 0.92;
  --cid-gauge-track: rgba(194, 201, 214, 0.18);
}

[data-cidrella-theme="dark-one"] {
  --cid-static-dns: #61afef;
  --cid-dynamic-dhcp: #98c379;
  --cid-reserved-dhcp: #c678dd;
  --cid-system: #9aa3b2;
  --cid-gateway: #e5c07b;
  --cid-reserved: #56b6c2;
  --cid-rogue: #e87d86;
  --cid-status-ok: #98c379;
  --cid-status-warn: #e5c07b;
  --cid-status-err: #e87d86;
  --cid-status-info: #61afef;
  --cid-status-muted: #929ba9;
  --cid-chart-1: #61afef;
  --cid-chart-2: #98c379;
  --cid-chart-3: #c678dd;
  --cid-chart-4: #e5c07b;
  --cid-chart-5: #e87d86;
  --cid-chart-6: #56b6c2;
  --cid-chart-7: #8fa2ff;
  --cid-chart-8: #d19a66;
  --cid-chart-9: #b6bd68;
  --cid-chart-10: #9aa3b2;
  --cid-chart-grid: rgba(171, 178, 191, 0.16);
  --cid-chart-text: #abb2bf;
  --cid-chart-line-fill-alpha: 0.22;
  --cid-chart-line-width: 2.25;
  --cid-chart-doughnut-alpha: 0.92;
  --cid-gauge-track: rgba(171, 178, 191, 0.18);
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
/* Circular icon backgrounds: white icon on colored circle */
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
  background: var(--cid-status-ok) !important;
}
.p-toast-message-info .p-toast-message-icon {
  background: var(--cid-status-info) !important;
}
.p-toast-message-warn .p-toast-message-icon {
  background: var(--cid-status-warn) !important;
}
.p-toast-message-error .p-toast-message-icon {
  background: var(--cid-status-err) !important;
}

/* ── Global badge utility classes ── */
.badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; display: inline-block; }
.badge-sm { font-size: 0.7rem; padding: 0.1rem 0.4rem; }

.badge-green   { background: color-mix(in srgb, var(--cid-status-ok) 20%, transparent);  color: var(--cid-status-ok); }
.badge-red     { background: color-mix(in srgb, var(--cid-status-err) 20%, transparent); color: var(--cid-status-err); }
.badge-blue    { background: color-mix(in srgb, var(--cid-status-info) 20%, transparent); color: var(--cid-status-info); }
.badge-yellow  { background: color-mix(in srgb, var(--cid-status-warn) 20%, transparent); color: var(--cid-status-warn); }
.badge-orange  { background: color-mix(in srgb, var(--cid-gateway) 20%, transparent); color: var(--cid-gateway); }
.badge-indigo  { background: color-mix(in srgb, var(--cid-reserved-dhcp) 20%, transparent); color: var(--cid-reserved-dhcp); }
.badge-purple  { background: color-mix(in srgb, var(--cid-reserved-dhcp) 20%, transparent); color: var(--cid-reserved-dhcp); }
.badge-muted   { background: color-mix(in srgb, var(--cid-status-muted) 15%, transparent); color: var(--cid-status-muted); }
.badge-primary { background: color-mix(in srgb, var(--p-primary-color) 20%, transparent); color: var(--p-primary-color); }

.badge-green-light  { background: color-mix(in srgb, var(--cid-status-ok) 15%, transparent); color: var(--cid-status-ok); }
.badge-red-light    { background: color-mix(in srgb, var(--cid-status-err) 15%, transparent); color: var(--cid-status-err); }
.badge-yellow-light { background: color-mix(in srgb, var(--cid-status-warn) 15%, transparent); color: var(--cid-status-warn); }
.badge-blue-light   { background: color-mix(in srgb, var(--cid-status-info) 15%, transparent); color: var(--cid-status-info); }

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

/* Taxonomy tag: tinted capsule for *categorical* flags only
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
.taxonomy-tag.taxonomy-warn   { background: color-mix(in srgb, var(--cid-status-warn) 16%, transparent); color: var(--cid-status-warn); }
.taxonomy-tag.taxonomy-err    { background: color-mix(in srgb, var(--cid-status-err) 16%, transparent); color: var(--cid-status-err); }
.taxonomy-tag.taxonomy-info   { background: color-mix(in srgb, var(--cid-status-info) 16%, transparent); color: var(--cid-status-info); }
.taxonomy-tag.taxonomy-muted  { background: color-mix(in srgb, var(--cid-status-muted) 16%, transparent); color: var(--cid-status-muted); }

.address-type-pill {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-sans, inherit);
  font-size: var(--app-fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  line-height: 1.4;
  white-space: nowrap;
}
.address-type-pill.type-static-dns {
  background: color-mix(in srgb, var(--cid-static-dns) 16%, transparent);
  color: var(--cid-static-dns);
}
.address-type-pill.type-dynamic-dhcp {
  background: color-mix(in srgb, var(--cid-dynamic-dhcp) 16%, transparent);
  color: var(--cid-dynamic-dhcp);
}
.address-type-pill.type-reserved-dhcp {
  background: color-mix(in srgb, var(--cid-reserved-dhcp) 18%, transparent);
  color: var(--cid-reserved-dhcp);
}
.address-type-pill.type-system {
  background: color-mix(in srgb, var(--cid-system) 16%, transparent);
  color: var(--cid-system);
}
.address-type-pill.type-unknown {
  background: transparent;
  border-color: color-mix(in srgb, var(--cid-status-muted) 45%, transparent);
  color: var(--cid-status-muted);
}
.address-type-pill.type-gateway {
  background: color-mix(in srgb, var(--cid-gateway) 16%, transparent);
  color: var(--cid-gateway);
}
.address-type-pill.type-reserved {
  background: color-mix(in srgb, var(--cid-reserved) 16%, transparent);
  color: var(--cid-reserved);
}
.address-type-pill.type-rogue {
  background: color-mix(in srgb, var(--cid-rogue) 16%, transparent);
  color: var(--cid-rogue);
}

/* Status text, for "state" values in dense data tables.
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
.status-text.state-err    { color: var(--cid-status-err); }
.status-text.state-warn   { color: var(--cid-status-warn); }
.status-text.state-ok     { color: var(--cid-status-ok); }
.status-text.state-info   { color: var(--cid-status-info); }
.status-text.state-muted  { color: var(--cid-status-muted); }
/* "Off" variants use a ring instead of a filled dot. Shape carries meaning
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
