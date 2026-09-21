<!-- The head of a reworked Analytics section: title, lede, and on the right a
     Refresh button and, when the page is range-driven, the shared range
     select. `track` prefixes the data-track ids (dashboard-refresh,
     dashboard-range). -->
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
import Select from '../ui/Select.js';
import Button from '../ui/Button.js';
import { RANGE_OPTIONS } from '../utils/chart-config.js';

defineProps({
  title: { type: String, required: true },
  lede: { type: String, default: '' },
  track: { type: String, required: true },
  loading: { type: Boolean, default: false },
  range: { type: String, default: undefined }, // omit to hide the select
});
const emit = defineEmits(['update:range', 'refresh']);
</script>
