<template>
  <div class="policy-editor" data-track="password-policy-editor">
    <div class="policy-row">
      <label for="password-min-length">Minimum length</label>
      <InputNumber
        v-model="minLength"
        input-id="password-min-length"
        :min="0"
        :max="1024"
        :use-grouping="false"
        :disabled="disabled"
        show-buttons
        class="min-length"
        data-track="password-policy-min-length"
        @blur="commitLength"
        @keyup.enter="commitLength"
      />
      <span class="help">0 means no minimum. The maximum is always 1024.</span>
    </div>
    <label
      v-for="rule in RULES"
      :key="rule.key"
      class="policy-row check"
      :for="`password-${rule.id}`"
    >
      <Checkbox
        :model-value="policy[rule.key]"
        binary
        :input-id="`password-${rule.id}`"
        :disabled="disabled"
        :data-track="`password-policy-${rule.id}`"
        @update:model-value="emit('save', { [rule.key]: $event === true })"
      />
      <span>{{ rule.label }}</span>
    </label>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import InputNumber from '../ui/InputNumber.js';
import Checkbox from '../ui/Checkbox.js';

// The four parts of the password rule, each saved on its own. The parent owns
// the policy (it comes from the server) and applies the patch this emits.
// Used by the first-run wizard's password step and Settings > Access.
const props = defineProps({
  policy: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['save']);

const RULES = [
  { key: 'requireMixedCase', id: 'mixed-case', label: 'Upper and lower case letters' },
  { key: 'requireNumber', id: 'number', label: 'A number' },
  {
    key: 'requireSymbol',
    id: 'symbol',
    label: 'A symbol (anything that is not a letter or digit)',
  },
];

const minLength = ref(props.policy.minLength ?? 0);
watch(
  () => props.policy.minLength,
  (v) => {
    minLength.value = v ?? 0;
  },
);

function commitLength() {
  const n = Number.isInteger(minLength.value) ? Math.min(Math.max(minLength.value, 0), 1024) : 0;
  minLength.value = n;
  if (n !== (props.policy.minLength ?? 0)) emit('save', { minLength: n });
}
</script>

<style scoped>
.policy-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.policy-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.9rem;
  flex-wrap: wrap;
}
.policy-row.check {
  cursor: pointer;
}
.policy-row label {
  font-weight: 500;
}
.min-length {
  width: 7.5rem;
}
.help {
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
}
</style>
