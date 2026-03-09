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
  --ipam-ground: #898989;
  --ipam-card: #c4c4c4;
}
.p-dark {
  --p-surface-ground: var(--p-surface-950);
  --p-surface-card: var(--p-surface-800);
  --p-surface-border: var(--p-surface-700);
  --ipam-ground: #1b1b1b;
  --ipam-card: #212121;
}

/* Monospace font for all DataTable body cells; headers stay sans-serif */
.p-datatable .p-datatable-tbody > tr > td {
  font-family: monospace;
}

/* Compact action buttons inside DataTable rows to reduce row height */
.p-datatable .p-button-sm.p-button-icon-only {
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
}

/* Fix PrimeVue TabView ink bar sizing incorrectly on initial mount */
.p-tabview-ink-bar {
  display: none !important;
}
.p-tabview-tablist-item-active > .p-tabview-tab-header {
  border-bottom-color: var(--p-primary-color) !important;
}

/* Uniform toast style: medium gray background, white text */
.p-toast-message {
  background: #444 !important;
  border: none !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
}
.p-toast-message-text,
.p-toast-summary,
.p-toast-detail {
  color: #fff !important;
}
.p-toast-close-button {
  color: #ccc !important;
}
/* Circular icon backgrounds — white icon on colored circle */
.p-toast-message-icon {
  color: #fff !important;
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
  background: #22c55e !important;
}
.p-toast-message-info .p-toast-message-icon {
  background: #3b82f6 !important;
}
.p-toast-message-warn .p-toast-message-icon {
  background: #eab308 !important;
}
.p-toast-message-error .p-toast-message-icon {
  background: #ef4444 !important;
}
</style>
