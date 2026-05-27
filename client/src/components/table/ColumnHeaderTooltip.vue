<template>
  <span
    class="column-header-tooltip"
    v-tooltip.top="{ value: column.description || column.header, showDelay: 1000 }"
  >
    {{ column.header }}
  </span>
</template>

<script setup>
defineProps({
  column: { type: Object, required: true }
});
</script>

<style scoped>
.column-header-tooltip {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
</style>
