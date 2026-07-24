<!--
  The one status dot. Renders a small colored indicator driven by the
  theme-safe --cid-status-* tokens, with the shape convention from
  App.vue's .status-text: filled dot for active states, hollow ring for
  muted/off so state survives grayscale and colorblindness. Never
  color-only: label is required and feeds the title + aria-label (add
  showLabel to render it as visible text). Extra attrs (data-track etc.)
  fall through to the root element.
-->
<template>
  <span class="cid-status-dot" :class="`sd-${kind}`"
        :title="decorative ? undefined : (title || label)"
        :role="decorative ? undefined : 'img'"
        :aria-hidden="decorative ? 'true' : undefined"
        :aria-label="decorative ? undefined : label">
    <span v-if="showLabel" class="sd-label">{{ label }}</span>
  </span>
</template>

<script setup>
defineProps({
  kind: {
    type: String,
    required: true,
    validator: (v) => ['ok', 'warn', 'err', 'info', 'muted'].includes(v),
  },
  label: { type: String, required: true },
  title: { type: String, default: '' },
  showLabel: { type: Boolean, default: false },
  // For hosts that render their own visible label right next to the dot
  // (StatusBadge): hide the dot from assistive tech so the state isn't
  // announced twice.
  decorative: { type: Boolean, default: false },
});
</script>

<style scoped>
.cid-status-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  vertical-align: middle;
}
.cid-status-dot::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}
.sd-ok    { color: var(--cid-status-ok); }
.sd-warn  { color: var(--cid-status-warn); }
.sd-err   { color: var(--cid-status-err); }
.sd-info  { color: var(--cid-status-info); }
.sd-muted { color: var(--cid-status-muted); }
/* Off/idle keeps the hollow-ring shape convention from .status-text */
.sd-muted::before {
  background: transparent;
  border: 1.5px solid currentColor;
  width: 7px;
  height: 7px;
}
.sd-label {
  color: var(--p-text-color);
  font-size: var(--app-fs-sm);
}
</style>
