<!--
  Status pill: StatusDot plus a visible label in a subtle capsule. Same
  kind vocabulary and --cid-status-* tokens as StatusDot. Use this where
  the state deserves more visual weight than inline text (table badges,
  panel headers). Extra attrs (data-track etc.) fall through.
-->
<template>
  <span class="cid-status-badge" :class="`sb-${kind}`" :title="title || label">
    <StatusDot :kind="kind" :label="label" decorative />
    <span class="sb-label">{{ label }}</span>
  </span>
</template>

<script setup>
import StatusDot from './StatusDot.vue';

defineProps({
  kind: {
    type: String,
    required: true,
    validator: (v) => ['ok', 'warn', 'err', 'info', 'muted'].includes(v),
  },
  label: { type: String, required: true },
  title: { type: String, default: '' },
});
</script>

<style scoped>
.cid-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: var(--app-fs-xs);
  font-weight: 600;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.sb-ok    { color: var(--cid-status-ok); }
.sb-warn  { color: var(--cid-status-warn); }
.sb-err   { color: var(--cid-status-err); }
.sb-info  { color: var(--cid-status-info); }
.sb-muted { color: var(--cid-status-muted); }
.sb-label { color: inherit; }
</style>
