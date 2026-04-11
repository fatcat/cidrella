<template>
  <div class="chart-card">
    <h4>{{ title }}</h4>
    <div class="card-row">
      <div class="chart-card">
        <div v-if="data" class="chart-wrap" :style="{ height: height }">
          <Line :data="data" :options="options" />
        </div>
        <p v-else class="empty-chart">{{ emptyText }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Line } from 'vue-chartjs';

defineProps({
  title: { type: String, required: true },
  data: { type: Object, default: null },
  options: { type: Object, required: true },
  emptyText: { type: String, default: 'No data in this range.' },
  height: { type: String, default: '240px' },
});
</script>
