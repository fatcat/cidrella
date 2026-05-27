<template>
  <span class="status-text" :class="className">{{ label }}</span>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  className: { type: String, default: 'state-muted' }
});
</script>
