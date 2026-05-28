<template>
  <Dialog v-model:visible="visible" header="Import from Pi-hole" modal :style="{ width: '32rem' }" data-track="dialog-pihole-import"
          @hide="panelRef?.resetState()">
    <PiholeImportPanel ref="panelRef" showCancel @cancel="visible = false" @imported="$emit('imported')" />
  </Dialog>
</template>

<script setup>
import { ref } from 'vue';
import Dialog from 'primevue/dialog';
import PiholeImportPanel from './PiholeImportPanel.vue';

defineEmits(['imported']);

const visible = ref(false);
const panelRef = ref(null);

function open() {
  panelRef.value?.resetState();
  visible.value = true;
}

defineExpose({ open });
</script>
