<template>
  <div class="discard-prompt" role="alertdialog" aria-live="assertive" aria-label="Unsaved changes">
    <p><strong>Discard your changes?</strong> This form has edits that have not been saved.</p>
    <div class="discard-actions">
      <Button
        label="Keep editing"
        severity="secondary"
        size="small"
        autofocus
        @click="emit('keep')"
      />
      <Button label="Discard" severity="danger" size="small" @click="emit('discard')" />
    </div>
  </div>
</template>

<script setup>
import Button from '../../../ui/Button.js';

// Inline unsaved-changes prompt for the workspace form dialogs. Rendered
// inside the dialog so it stays the topmost thing without stacking a second
// overlay, and Escape keeps meaning "close this dialog" rather than "close
// every open dialog".
const emit = defineEmits(['keep', 'discard']);
</script>

<style scoped>
.discard-prompt {
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--cid-orange-500);
  border-radius: 8px;
  background: color-mix(in srgb, var(--cid-orange-500) 10%, var(--cid-surface-card));
}
.discard-prompt p {
  margin: 0;
}
.discard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
