<template>
  <div class="app-layout">
    <HeaderBar />
    <main class="main-content">
      <router-view />
    </main>
    <FooterBar />
    <DebugPanel />
  </div>
</template>

<script setup>
import HeaderBar from './HeaderBar.vue';
import FooterBar from './FooterBar.vue';
import DebugPanel from './DebugPanel.vue';
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.main-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--p-surface-ground);
}
</style>
