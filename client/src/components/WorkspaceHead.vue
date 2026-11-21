<!-- The head of a reworked Analytics section: title, lede, and on the right a
     Refresh button and, when the page is range-driven, the shared range
     select. A page whose figures come from more than one instance passes
     `instance` and `instances` for the instance select beside it
     (composables/useInstanceFilter.js). `track` prefixes the data-track ids
     (dashboard-refresh, dashboard-range, dashboard-instance). -->
<template>
  <header class="workspace-head">
    <div>
      <h1>{{ title }}</h1>
      <p class="lede">
        <slot>{{ lede }}</slot>
      </p>
    </div>
    <div class="head-actions">
      <Select
        v-if="instance !== undefined"
        :model-value="instance"
        :options="instanceOptions"
        optionLabel="label"
        optionValue="value"
        size="small"
        style="width: 12rem"
        aria-label="Instance"
        :data-track="`${track}-instance`"
        @update:model-value="emit('update:instance', $event)"
      />
      <Select
        v-if="range !== undefined"
        :model-value="range"
        :options="RANGE_OPTIONS"
        optionLabel="label"
        optionValue="value"
        size="small"
        style="width: 10rem"
        aria-label="Range"
        :data-track="`${track}-range`"
        @update:model-value="emit('update:range', $event)"
      />
      <Button
        icon="pi pi-refresh"
        severity="secondary"
        text
        rounded
        size="small"
        aria-label="Refresh"
        :data-track="`${track}-refresh`"
        :loading="loading"
        @click="emit('refresh')"
      />
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import Select from '../ui/Select.js';
import Button from '../ui/Button.js';
import { ALL_INSTANCES, RANGE_OPTIONS } from '../utils/chart-config.js';

const props = defineProps({
  title: { type: String, required: true },
  lede: { type: String, default: '' },
  track: { type: String, required: true },
  loading: { type: Boolean, default: false },
  range: { type: String, default: undefined }, // omit to hide the select
  instance: { type: String, default: undefined }, // 'all' or an instance id; omit to hide
  instances: { type: Array, default: () => [] }, // [{ instance_id, name }]
});
const emit = defineEmits(['update:range', 'update:instance', 'refresh']);

const instanceOptions = computed(() => [
  { label: 'All instances', value: ALL_INSTANCES },
  ...props.instances.map((i) => ({ label: i.name, value: i.instance_id })),
]);
</script>
