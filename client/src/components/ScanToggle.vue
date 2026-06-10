<template>
  <div class="field">
    <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Liveness Scanning</label>
    <div class="scan-toggle-group">
      <button type="button" :class="['scan-toggle-btn', 'scan-inherit', { active: modelValue === null }]"
              @click="$emit('update:modelValue', null)">Inherit</button>
      <button type="button" :class="['scan-toggle-btn', 'scan-enabled', { active: modelValue === true, resolved: modelValue === null && resolvedEnabled }]"
              @click="$emit('update:modelValue', true)">Enabled</button>
      <button type="button" :class="['scan-toggle-btn', 'scan-disabled', { active: modelValue === false, resolved: modelValue === null && !resolvedEnabled }]"
              @click="$emit('update:modelValue', false)">Disabled</button>
    </div>
    <small v-if="modelValue === null" style="font-size: 0.75rem; color: var(--p-text-muted-color)">
      Inherits from subnet — scanning is {{ resolvedEnabled ? 'enabled' : 'disabled' }} for this network
    </small>
    <small v-else-if="modelValue === true" style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is enabled for this network</small>
    <small v-else style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is disabled for this network</small>
  </div>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, default: null },
  resolvedEnabled: { type: Boolean, default: false },
});
defineEmits(['update:modelValue']);
</script>

<style scoped>
.scan-toggle-group {
  display: inline-flex;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--p-surface-border);
}
.scan-toggle-btn {
  padding: 0.3rem 0.75rem;
  font-size: 0.8rem;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--p-text-color);
  transition: background 0.15s, color 0.15s;
}
.scan-toggle-btn + .scan-toggle-btn {
  border-left: 1px solid var(--p-surface-border);
}
.scan-toggle-btn:hover {
  background: var(--p-surface-200);
}
:global(.p-dark) .scan-toggle-btn:hover {
  background: var(--p-surface-700);
}
.scan-inherit.active {
  background: var(--p-surface-300);
  color: var(--p-text-color);
}
:global(.p-dark) .scan-inherit.active {
  background: var(--p-surface-600);
}
.scan-enabled.active {
  background: color-mix(in srgb, var(--p-green-500) 25%, transparent);
  color: var(--p-green-500);
}
.scan-disabled.active {
  background: color-mix(in srgb, var(--p-blue-500) 25%, transparent);
  color: var(--p-blue-500);
}
.scan-enabled.resolved {
  background: color-mix(in srgb, var(--p-green-500) 10%, transparent);
  color: var(--p-green-500);
  opacity: 0.7;
}
.scan-disabled.resolved {
  background: color-mix(in srgb, var(--p-blue-500) 10%, transparent);
  color: var(--p-blue-500);
  opacity: 0.7;
}
</style>
