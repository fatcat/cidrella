<!-- The fields that describe a Network Range Type: name, color, description.
     RangeTypeDialog is these fields alone; RangeEditor shows them inline
     when the admin picks "New type" so a range and its label are one save. -->
<template>
  <label>
    Type name
    <InputText
      :model-value="modelValue.name"
      class="w-full"
      maxlength="64"
      required
      data-track="workspace-range-type-name"
      @update:model-value="update('name', $event)"
    />
  </label>
  <label class="workspace-color-field">
    Color
    <!-- eslint-disable-next-line vue/no-restricted-html-elements -- no ui wrapper covers a color input -->
    <input :value="modelValue.color" type="color" @input="update('color', $event.target.value)" />
    <InputText
      :model-value="modelValue.color"
      maxlength="7"
      @update:model-value="update('color', $event)"
    />
    <span class="color-presets">
      <button
        v-for="preset in RANGE_COLOR_PRESETS"
        :key="preset"
        type="button"
        class="color-preset"
        :style="{ background: preset }"
        :aria-label="`Use ${preset}`"
        :title="preset"
        @click="update('color', preset)"
      ></button>
    </span>
    <small class="muted color-note">
      Colors the grid uses for a status (gray, amber, violet, red, cyan, blue, green) and their near
      neighbors are refused.
    </small>
  </label>
  <label>
    Type description
    <InputText
      :model-value="modelValue.description"
      class="w-full"
      maxlength="1024"
      @update:model-value="update('description', $event)"
    />
  </label>
</template>

<script setup>
import InputText from '../../../ui/InputText.js';
import { RANGE_COLOR_PRESETS } from '../../../utils/rangeTypeColors.js';

const props = defineProps({
  modelValue: { type: Object, required: true }, // { name, color, description }
});
const emit = defineEmits(['update:modelValue']);

function update(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
</script>

<style scoped>
.workspace-color-field {
  grid-template-columns: auto 3rem 1fr;
  align-items: center;
}
.color-presets {
  grid-column: 2 / -1;
  display: flex;
  gap: 0.35rem;
}
.color-preset {
  width: 1.4rem;
  height: 1.4rem;
  border: 1px solid var(--cid-surface-border);
  border-radius: 4px;
  cursor: pointer;
}
.color-note {
  grid-column: 2 / -1;
}
</style>
