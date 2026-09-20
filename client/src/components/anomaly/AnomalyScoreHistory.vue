<!-- One client's score over time. Flagged windows get a bigger red point and
     list their top factors in the tooltip. Raw scores on the axis: negative
     is anomalous, so the flag line at 0 has everything interesting below it. -->
<template>
  <div class="client-chart">
    <Line :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line } from 'vue-chartjs';
import { chartColor, chartFill } from '../../utils/chart-config.js';
import { formatDateTime } from '../../utils/dateFormat.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);
ChartJS.defaults.elements.line.borderWidth = 1;

const props = defineProps({
  history: { type: Array, required: true }, // rows from /anomalies/client/:identity, any order
});

const sorted = computed(() =>
  [...props.history].sort((a, b) => String(a.window_start).localeCompare(String(b.window_start))),
);

const chartData = computed(() => ({
  labels: sorted.value.map((r) => formatDateTime(r.window_start)),
  datasets: [
    {
      label: 'Anomaly Score',
      data: sorted.value.map((r) => r.anomaly_score),
      borderColor: chartColor(3),
      backgroundColor: chartFill(3, 0.12),
      fill: true,
      tension: 0.3,
      pointRadius: sorted.value.map((r) => (r.is_anomaly ? 5 : 2)),
      pointBackgroundColor: sorted.value.map((r) =>
        r.is_anomaly ? chartColor('err') : chartColor(3),
      ),
    },
  ],
}));

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    y: {
      title: { display: true, text: 'Score', color: chartColor('text') },
      ticks: { color: chartColor('text') },
      grid: { color: chartColor('grid') },
    },
    x: { display: false },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        afterLabel: (ctx) => {
          const item = sorted.value[ctx.dataIndex];
          if (item?.is_anomaly && item?.top_features?.length) {
            return item.top_features.map((f) => `  ${f.label}`).join('\n');
          }
          return '';
        },
      },
    },
    datalabels: { display: false },
  },
}));
</script>

<style scoped>
.client-chart {
  height: 180px;
}
</style>
