<!-- Confirm taking a client out of anomaly detection. Used by the classic
     Anomalies panel and the triage page's Evidence drawer. -->
<template>
  <ConfirmDialog
    :visible="visible"
    header="Allowlist Client"
    width="26rem"
    severity="warn"
    confirm-label="Allowlist"
    confirm-icon="pi pi-shield"
    :loading="busy"
    confirm-track="anomalies-allowlist-confirm"
    @update:visible="emit('update:visible', $event)"
    @confirm="confirm"
  >
    <p>
      Allowlist <strong>{{ target?.client_ip }}</strong>
      <span v-if="target?.hostname"> ({{ target.hostname }})</span>
      from anomaly detection?
    </p>
    <p class="text-muted" style="font-size: 0.85rem">
      This will stop monitoring this client and delete all existing anomaly scores and model data
      for it.
    </p>
    <div class="field" style="margin-top: 0.75rem">
      <label style="font-size: 0.85rem" for="anomaly-allowlist-reason">Reason (optional)</label>
      <InputText
        v-model="reason"
        input-id="anomaly-allowlist-reason"
        placeholder="e.g. Known scanner, expected behavior"
        fluid
        style="margin-top: 0.25rem"
      />
    </div>
  </ConfirmDialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import ConfirmDialog from '../ConfirmDialog.vue';
import InputText from '../../ui/InputText.js';
import { useAnomalyStore } from '../../stores/anomalies.js';
import { useToast } from '../../ui/useToast.js';
import { apiError } from '../../utils/format.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  target: { type: Object, default: null }, // { client_ip, hostname, identity }
});
const emit = defineEmits(['update:visible', 'allowlisted']);

const store = useAnomalyStore();
const toast = useToast();
const reason = ref('');
const busy = ref(false);

watch(
  () => props.visible,
  (open) => {
    if (open) reason.value = '';
  },
);

async function confirm() {
  if (!props.target) return;
  busy.value = true;
  try {
    await store.allowlistClient(props.target.client_ip, reason.value || null);
    emit('update:visible', false);
    emit('allowlisted', props.target);
    toast.add({
      severity: 'success',
      summary: 'Client allowlisted',
      detail: props.target.client_ip,
      life: 3000,
    });
  } catch (err) {
    toast.add({ severity: 'error', summary: apiError(err), life: 4000 });
  } finally {
    busy.value = false;
  }
}
</script>
