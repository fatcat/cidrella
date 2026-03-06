<template>
  <div class="app-layout">
    <HeaderBar />
    <main class="main-content">
      <router-view />
    </main>
    <DebugPanel />
  </div>
</template>

<script setup>
import HeaderBar from './HeaderBar.vue';
import DebugPanel from './DebugPanel.vue';
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.main-content {
  flex: 1;
  overflow: hidden;
  background: var(--p-surface-ground);
}
</style>
