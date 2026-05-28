<template>
  <div class="chart-card">
    <h4>{{ title }}</h4>
    <div class="card-row">
      <div class="chart-card">
        <div v-if="items.length" class="doughnut-wrap">
          <Doughnut :data="chartData" :options="doughnutOptions" :plugins="[ChartDataLabels]" />
        </div>
        <p v-else class="empty-chart">No data in this range.</p>
      </div>
      <div class="chart-card">
        <DataTable v-if="items.length" :value="items" size="small" style="margin: 0 10%">
          <Column v-if="labelField" :field="labelField" :header="labelHeader" />
          <Column v-else :header="labelHeader">
            <template #body="slotProps">
              <slot name="label" v-bind="slotProps" />
            </template>
          </Column>
          <Column field="count" header="Count">
            <template #body="{ data }">{{ formatNumber(Number(data.count)) }}</template>
          </Column>
        </DataTable>
        <p v-else class="empty-chart">No data in this range.</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import { Doughnut } from 'vue-chartjs';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { makeDoughnutOptions } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';

defineProps({
  title: { type: String, required: true },
  items: { type: Array, required: true },
  chartData: { type: Object, required: true },
  labelField: { type: String, default: null },
  labelHeader: { type: String, default: 'Label' },
});

const doughnutOptions = computed(() => makeDoughnutOptions());
</script>
