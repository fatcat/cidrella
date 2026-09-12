<template>
  <div>
    <div v-if="loading" class="muted">Loading settings...</div>
    <div v-else class="content-card settings-form">
      <h3>New Network Defaults</h3>
      <div class="field">
        <label>Default Gateway Position</label>
        <SelectButton
          v-model="gatewayPosition"
          :options="gatewayPositionOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
          data-track="settings-default-gateway-position"
        />
        <small class="field-help">
          Newly created IPv4 networks use the first or last allocatable address. The network and
          broadcast addresses are never selected.
        </small>
      </div>
      <div class="settings-actions">
        <Button
          label="Save Settings"
          icon="pi pi-save"
          @click="saveSettings"
          :loading="saving"
          :disabled="!isDirty"
          data-track="settings-save-network-defaults"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import Button from '../../ui/Button.js';
import SelectButton from '../../ui/SelectButton.js';
import { useToast } from '../../ui/useToast.js';
import { useSubnetStore } from '../../stores/subnets.js';
import { apiError } from '../../utils/format.js';
import { normalizeGatewayPositionDefault } from '../../utils/ip.js';

const store = useSubnetStore();
const toast = useToast();
const loading = ref(true);
const saving = ref(false);
const gatewayPosition = ref('first');
const savedGatewayPosition = ref('first');

const gatewayPositionOptions = [
  { label: 'First allocatable IP', value: 'first' },
  { label: 'Last allocatable IP', value: 'last' },
];

const isDirty = computed(() => gatewayPosition.value !== savedGatewayPosition.value);

async function saveSettings() {
  saving.value = true;
  try {
    await store.updateSetting('default_gateway_position', gatewayPosition.value);
    savedGatewayPosition.value = gatewayPosition.value;
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const settings = await store.getSettings();
    const value = normalizeGatewayPositionDefault(settings.default_gateway_position);
    gatewayPosition.value = value;
    savedGatewayPosition.value = value;
  } catch {
    /* use the server default */
  }
  loading.value = false;
});
</script>

<style scoped>
.muted {
  color: var(--cid-text-muted-color);
}
.content-card {
  margin: 0;
  padding: 1.25rem;
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
}
.content-card h3 {
  margin: 0 0 0.75rem;
}
.settings-form .field {
  max-width: 38rem;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
}
.field-help {
  display: block;
  margin-top: 0.4rem;
  color: var(--cid-text-muted-color);
  font-size: var(--app-fs-xs);
  line-height: 1.4;
}
.settings-actions {
  margin-top: 1rem;
}
</style>
