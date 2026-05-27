<template>
  <span
    v-if="display?.label"
    class="address-type-pill"
    :class="display.className"
    v-tooltip.top="tooltip || null"
  >
    {{ display.label }}
  </span>
  <span v-else class="cell-muted">—</span>
</template>

<script setup>
defineProps({
  display: { type: Object, default: null },
  tooltip: { type: String, default: null }
});
</script>
