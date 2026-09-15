<template>
  <Dialog
    :visible="visible"
    modal
    :header="isReserve ? 'Create IP Reservation' : 'Release IP Reservation'"
    :style="{ width: '32rem', maxWidth: 'calc(100vw - 2rem)' }"
    @update:visible="requestClose"
  >
    <form class="reservation-form" @submit.prevent="submit">
      <label v-if="!address">
        IP address
        <input v-model="targetAddress" required autocomplete="off" />
      </label>
      <p v-else>
        <strong>{{ address }}</strong>
      </p>
      <label v-if="isReserve">
        Reservation note
        <textarea v-model="note" required rows="3" maxlength="1024" autofocus />
      </label>
      <p v-else class="warning">
        The address will return to DHCP Scope or available status according to server policy. DHCP
        leases and DNS records are not removed.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <DiscardPrompt v-if="confirmingDiscard" @keep="keepEditing" @discard="discard" />
      <div class="dialog-actions">
        <Button label="Cancel" severity="secondary" :disabled="busy" @click="requestClose()" />
        <Button
          type="submit"
          :label="isReserve ? 'Reserve address' : 'Release reservation'"
          :severity="isReserve ? undefined : 'danger'"
          :disabled="busy || (isReserve && !note.trim())"
          :loading="busy"
        />
      </div>
    </form>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import api from '../../../api/client.js';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import { apiError } from '../../../utils/format.js';
import { useDiscardGuard } from '../composables/useDiscardGuard.js';
import DiscardPrompt from './DiscardPrompt.vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  address: { type: String, required: true },
  mode: {
    type: String,
    required: true,
    validator: (value) => ['reserve', 'release'].includes(value),
  },
});
const emit = defineEmits(['update:visible', 'saved']);
const note = ref('');
const targetAddress = ref('');
const busy = ref(false);
const error = ref('');
const isReserve = computed(() => props.mode === 'reserve');

// Release has nothing to type, so only the reserve form can be dirty.
const {
  confirmingDiscard,
  requestClose,
  keepEditing,
  discard,
  reset: resetGuard,
} = useDiscardGuard({
  busy,
  isDirty: () =>
    isReserve.value && (note.value.trim() !== '' || targetAddress.value.trim() !== props.address),
  close: () => emit('update:visible', false),
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      note.value = '';
      targetAddress.value = props.address;
      error.value = '';
      resetGuard();
    }
  },
  { immediate: true },
);

async function submit() {
  const cleanNote = note.value.trim();
  const cleanAddress = targetAddress.value.trim();
  if (busy.value || !cleanAddress || (isReserve.value && !cleanNote)) return;
  busy.value = true;
  error.value = '';
  const allocationState = isReserve.value ? 'reserved' : 'unassigned';
  try {
    await api.put(`/subnets/${props.subnetId}/ips/${encodeURIComponent(cleanAddress)}/allocation`, {
      allocation_state: allocationState,
      note: isReserve.value ? cleanNote : null,
    });
    emit('saved', {
      address: cleanAddress,
      allocation_state: allocationState,
      message: isReserve.value ? 'IP Reservation created' : 'IP Reservation released',
    });
    emit('update:visible', false);
  } catch (requestError) {
    error.value = apiError(requestError);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.reservation-form {
  display: grid;
  gap: 1rem;
}
.reservation-form p {
  margin: 0;
}
label {
  display: grid;
  gap: 0.4rem;
  font-weight: 650;
}
textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--cid-surface-border);
  border-radius: 6px;
  padding: 0.65rem;
  background: var(--cid-surface-card);
  color: var(--cid-text-color);
  font: inherit;
}
input {
  border: 1px solid var(--cid-surface-border);
  border-radius: 6px;
  padding: 0.65rem;
  background: var(--cid-surface-card);
  color: var(--cid-text-color);
  font: inherit;
}
.warning,
.error {
  color: var(--cid-red-600);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
