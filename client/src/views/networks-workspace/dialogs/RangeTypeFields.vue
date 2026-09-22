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
</style>
