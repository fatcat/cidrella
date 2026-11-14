<template>
  <span class="suggest-address">
    <Button
      label="Suggest"
      icon="pi pi-angle-down"
      icon-pos="right"
      size="small"
      severity="secondary"
      text
      aria-haspopup="menu"
      :disabled="!subnetId || busy"
      :loading="busy"
      data-track="suggest-address"
      @click="openMenu"
    />
    <ContextMenu ref="menuRef" :model="items" />
  </span>
</template>

<script setup>
// A free address for an editor's address field (docs/IPV6-HANDLING.md, rule
// 2): the server picks one the read model shows available, either the next
// free one or a random one. Nothing is held; the editor's own write decides.
import { ref } from 'vue';
import Button from '../ui/Button.js';
import ContextMenu from '../ui/ContextMenu.js';
import { useToast } from '../ui/useToast.js';
import { useSubnetStore } from '../stores/subnets.js';
import { apiError } from '../utils/format.js';

const props = defineProps({
  subnetId: { type: [Number, String], default: null },
  // A CIDR inside the network or one of its range ids.
  within: { type: [Number, String], default: null },
});
const emit = defineEmits(['suggested']);
const toast = useToast();
const menuRef = ref(null);
const busy = ref(false);

const items = [
  { label: 'Next free', icon: 'pi pi-arrow-right', command: () => suggest('sequential') },
  { label: 'Random', icon: 'pi pi-sync', command: () => suggest('random') },
];

function openMenu(event) {
  menuRef.value?.show(event);
}

async function suggest(strategy) {
  if (!props.subnetId || busy.value) return;
  busy.value = true;
  try {
    const result = await useSubnetStore().suggestAddress(props.subnetId, {
      strategy,
      within: props.within,
    });
    emit('suggested', result.ip_address);
  } catch (err) {
    toast.add({ severity: 'warn', summary: 'No suggestion', detail: apiError(err), life: 5000 });
  } finally {
    busy.value = false;
  }
}
</script>
