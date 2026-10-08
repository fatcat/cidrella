<template>
  <Dialog
    :visible="visible"
    modal
    header="Manage folders"
    :style="{ width: '34rem', maxWidth: 'calc(100vw - 2rem)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="folder-list">
      <div v-for="folder in folders" :key="folder.id">
        <span
          ><strong>{{ folder.name }}</strong
          ><small>{{ folder.networks.length }} networks</small></span
        >
        <Button label="Edit" severity="secondary" @click="emit('edit', folder)" />
        <Button label="Delete" severity="danger" text @click="emit('delete', folder)" />
      </div>
      <p v-if="!folders.length">No folders are configured.</p>
    </div>
    <template #footer>
      <Button label="Close" severity="secondary" @click="emit('update:visible', false)" />
      <Button label="Create folder" icon="pi pi-plus" @click="emit('create')" />
    </template>
  </Dialog>
</template>

<script setup>
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';

defineProps({
  visible: { type: Boolean, default: false },
  folders: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:visible', 'create', 'edit', 'delete']);
</script>

<style scoped>
.folder-list {
  display: grid;
  gap: 0.5rem;
}
.folder-list > div {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--cid-surface-border);
  padding: 0.55rem 0;
}
.folder-list span {
  display: grid;
  gap: 0.15rem;
}
.folder-list small {
  color: var(--cid-text-color-secondary);
}
</style>
