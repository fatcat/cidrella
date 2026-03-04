<template>
  <div class="app-layout">
    <NavSidebar />
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import NavSidebar from './NavSidebar.vue';
</script>

<style scoped>
.app-layout {
  display: flex;
  min-height: 100vh;
}
.main-content {
  flex: 1;
  padding: 1.5rem 2rem;
  background: var(--p-surface-ground);
}
</style>
