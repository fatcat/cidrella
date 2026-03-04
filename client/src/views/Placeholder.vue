<template>
  <div class="placeholder">
    <h2>{{ route.meta.label || route.name }}</h2>
    <p>This section is under development.</p>
  </div>
</template>

<script setup>
import { useRoute } from 'vue-router';
const route = useRoute();
</script>

<style scoped>
.placeholder h2 {
  margin: 0 0 0.5rem 0;
}
.placeholder p {
  color: var(--p-text-muted-color);
}
</style>
