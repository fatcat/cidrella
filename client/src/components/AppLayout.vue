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
import { onMounted } from 'vue';
import HeaderBar from './HeaderBar.vue';
import FooterBar from './FooterBar.vue';
import DebugPanel from './DebugPanel.vue';
import { useToast } from '../ui/useToast.js';

const toast = useToast();

// A sign-in that spent a backup code leaves the remaining count for the
// shell to mention, since the sign-in page has no toast of its own.
onMounted(() => {
  let low = null;
  try {
    low = sessionStorage.getItem('cidrella_backup_codes_low');
    if (low !== null) sessionStorage.removeItem('cidrella_backup_codes_low');
  } catch {
    /* storage unavailable */
  }
  if (low === null) return;
  const n = Number(low);
  toast.add({
    severity: 'warn',
    summary: n === 0 ? 'No backup codes left' : `${n} backup code${n === 1 ? '' : 's'} left`,
    detail: 'Get a fresh set under Settings > Access > Two-factor.',
    life: 12000,
  });
});
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
  background: var(--cid-surface-ground);
}
</style>
