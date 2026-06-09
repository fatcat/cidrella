<!-- Temporary placeholder for sub-tabs whose inline section hasn't been extracted
     yet (SET-2 / SET-3). Swapped out in settingsAreas.js as each is built. -->
<template>
  <div class="pending-section">
    <i class="pi pi-wrench"></i>
    <p>This section is being migrated into the new Settings shell.</p>
  </div>
</template>
<style scoped>
.pending-section {
  display: flex; flex-direction: column; align-items: center; gap: 0.6rem;
  padding: 3rem 1rem; color: var(--p-text-muted-color); font-size: var(--app-fs-sm);
}
.pending-section .pi { font-size: 1.6rem; opacity: 0.6; }
</style>
