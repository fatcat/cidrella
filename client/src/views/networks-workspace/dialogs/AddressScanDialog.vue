<template>
  <Dialog
    :visible="visible"
    modal
    :header="mode === 'policy' ? 'Address scanning policy' : 'Probe address'"
    :style="{ width: '31rem', maxWidth: 'calc(100vw - 2rem)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="scan-form" @submit.prevent="submit">
      <p>
        <strong>{{ address }}</strong>
      </p>
      <fieldset v-if="mode === 'policy'">
        <legend>Scanning policy</legend>
        <label v-for="choice in choices" :key="choice.label">
          <input v-model="scanEnabled" type="radio" :value="choice.value" />
          <span
            ><strong>{{ choice.label }}</strong
            ><small>{{ choice.help }}</small></span
          >
        </label>
      </fieldset>
      <p v-else>
        Run an immediate liveness probe. A completed probe with no response remains distinct from an
        online result.
      </p>
      <p v-if="result" class="result" :class="result.tone" role="status">{{ result.message }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <Button label="Close" severity="secondary" :disabled="busy" @click="close" />
        <Button
          type="submit"
          :label="mode === 'policy' ? 'Save policy' : 'Probe now'"
          :loading="busy"
          :disabled="busy || (mode === 'probe' && !supportsProbe)"
        />
      </div>
    </form>
  </Dialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import api from '../../../api/client.js';
import Button from '../../../ui/Button.js';
import Dialog from '../../../ui/Dialog.js';
import { apiError } from '../../../utils/format.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  subnetId: { type: [Number, String], required: true },
  address: { type: String, required: true },
  mode: { type: String, required: true, validator: (value) => ['policy', 'probe'].includes(value) },
  currentOverride: { type: [Boolean, Number], default: null },
  addressFamily: { type: Number, default: 4 },
});
const emit = defineEmits(['update:visible', 'changed']);
const choices = [
  { label: 'Inherit', value: 'inherit', help: 'Follow network and global scanning policy.' },
  { label: 'On', value: 'on', help: 'Explicitly enable scanning for this address.' },
  { label: 'Off', value: 'off', help: 'Explicitly disable scanning for this address.' },
];
const scanEnabled = ref('inherit');
const busy = ref(false);
const error = ref('');
const result = ref(null);
const supportsProbe = props.addressFamily === 4;

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    scanEnabled.value =
      props.currentOverride == null ? 'inherit' : props.currentOverride ? 'on' : 'off';
    error.value = '';
    result.value = null;
  },
  { immediate: true },
);

function close() {
  if (!busy.value) emit('update:visible', false);
}

async function submit() {
  if (busy.value || (props.mode === 'probe' && !supportsProbe)) return;
  busy.value = true;
  error.value = '';
  try {
    if (props.mode === 'policy') {
      const value = scanEnabled.value === 'inherit' ? null : scanEnabled.value === 'on';
      await api.put(
        `/subnets/${props.subnetId}/ips/${encodeURIComponent(props.address)}/scan-enabled`,
        { scan_enabled: value },
      );
      emit('changed', 'Address scanning policy updated');
      emit('update:visible', false);
    } else {
      const { data } = await api.post('/scans/probe', {
        ip: props.address,
        subnet_id: props.subnetId,
      });
      const method = String(data.method || 'probe').toUpperCase();
      result.value = {
        tone: data.responded ? 'success' : 'warning',
        message: data.responded
          ? `${props.address} responded via ${method}${data.mac ? ` · ${data.mac}` : ''}.`
          : `${props.address} did not respond via ${method}.`,
      };
      emit('changed', result.value.message);
    }
  } catch (requestError) {
    error.value = apiError(requestError);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.scan-form,
fieldset,
fieldset label,
fieldset label span {
  display: grid;
  gap: 0.55rem;
}
.scan-form p {
  margin: 0;
}
fieldset {
  border: 0;
  padding: 0;
}
fieldset label {
  grid-template-columns: auto 1fr;
  align-items: start;
}
fieldset label span {
  gap: 0.15rem;
}
fieldset small {
  color: var(--cid-text-color-secondary);
}
.error,
.result.warning {
  color: var(--cid-red-600);
}
.result.success {
  color: var(--cid-green-600);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
