<!-- A network's gateway: its position (first, last, none or custom) and the
     address. Used by the network form, the network wizard and the DHCP scope
     dialog; the parent owns what the address becomes for each position. -->
<template>
  <div class="field">
    <label>Gateway</label>
    <div class="gateway-row">
      <SelectButton
        :model-value="position"
        :options="GATEWAY_POSITION_OPTIONS"
        optionLabel="label"
        optionValue="value"
        size="small"
        :allowEmpty="false"
        :data-track="track"
        @update:model-value="emit('update:position', $event)"
      />
    </div>
    <InputText
      :model-value="address"
      :placeholder="placeholder"
      :disabled="position !== 'custom' && position !== 'none'"
      class="w-full"
      @update:model-value="emit('update:address', $event)"
    />
    <slot />
  </div>
</template>

<script setup>
import InputText from '../ui/InputText.js';
import SelectButton from '../ui/SelectButton.js';
import { GATEWAY_POSITION_OPTIONS } from '../utils/ip.js';

defineProps({
  position: { type: String, default: 'first' },
  address: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  track: { type: String, default: null },
});
const emit = defineEmits(['update:position', 'update:address']);
</script>

<style scoped>
.gateway-row {
  margin-bottom: 4px;
}
</style>
