<!-- The three inputs that name a controller to join: address, port and join
     token (composables/useJoinTarget.js holds their state and validation).
     First run's Join step shows them in the first-run look; the rejoin of a
     replaced controller in the settings look. -->
<template>
  <div :class="firstRun ? 'fr-field' : 'join-field'">
    <label :for="`${idPrefix}-address`">Controller address</label>
    <InputText
      :id="`${idPrefix}-address`"
      v-model="address"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      :class="monoClass"
      :data-track="`${track}-address`"
    />
    <span :class="helpClass">The name or IP address you open the controller at.</span>
  </div>
  <div :class="firstRun ? 'fr-field fr-gap' : 'join-field'">
    <label :for="`${idPrefix}-port`">Port</label>
    <InputNumber
      v-model="port"
      :input-id="`${idPrefix}-port`"
      :min="1"
      :max="65535"
      :use-grouping="false"
      :disabled="disabled"
      :data-track="`${track}-port`"
    />
    <span :class="helpClass">The controller's HTTPS port.</span>
  </div>
  <div :class="firstRun ? 'fr-field fr-gap' : 'join-field'">
    <label :for="`${idPrefix}-token`">Join token</label>
    <InputText
      :id="`${idPrefix}-token`"
      v-model="token"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      :class="monoClass"
      :data-track="`${track}-token`"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import InputNumber from '../../ui/InputNumber.js';
import InputText from '../../ui/InputText.js';

const props = defineProps({
  // Prefix of the inputs' ids and of their data-track ids.
  idPrefix: { type: String, required: true },
  track: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  firstRun: { type: Boolean, default: false },
});
const address = defineModel('address', { type: String, default: '' });
// null while the field is cleared, which any prop type allows.
const port = defineModel('port', { type: Number, default: 443 });
const token = defineModel('token', { type: String, default: '' });

const monoClass = computed(() => (props.firstRun ? 'fr-mono' : 'mono'));
const helpClass = computed(() => (props.firstRun ? 'fr-help' : 'field-help'));
</script>

<style scoped>
.join-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-width: 26rem;
  margin-bottom: 0.9rem;
}
.join-field label {
  font-weight: 500;
}
</style>
