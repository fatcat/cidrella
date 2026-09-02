<template>
  <div class="theme-lab">
    <section class="lab-header">
      <div>
        <h1>Theme Lab</h1>
        <p>Development-only visual matrix for semantic colors, tables, and charts.</p>
      </div>
      <Select
        v-model="selectedTheme"
        :options="themeOptions"
        optionLabel="label"
        optionValue="value"
        size="small"
        class="theme-select"
      />
    </section>

    <section class="lab-grid">
      <article class="lab-panel">
        <h2>Address Types</h2>
        <div class="sample-row">
          <AddressTypePill v-for="item in addressTypes" :key="item.label" :display="item" />
        </div>
      </article>

      <article class="lab-panel">
        <h2>Status Text</h2>
        <div class="sample-row">
          <StatusText v-for="state in statusStates" :key="state.label" :label="state.label" :className="state.className" />
        </div>
      </article>

      <article class="lab-panel">
        <h2>Header Chips</h2>
        <div class="chip-row">
          <span class="status-chip chip-ok"><span class="card-dot dot-up"></span><span class="status-chip-label">dnsmasq</span></span>
          <span class="status-chip chip-ok"><span class="card-dot dot-ok"></span><span class="status-chip-label">Scanner idle</span></span>
          <span class="status-chip chip-warn"><span class="card-dot dot-warn"></span><span class="status-chip-label">RAM 72%</span></span>
          <span class="status-chip chip-err"><span class="card-dot dot-down"></span><span class="status-chip-label">Disk 91%</span></span>
        </div>
      </article>

      <article class="lab-panel">
        <h2>Badges</h2>
        <div class="sample-row">
          <span class="badge badge-green">success</span>
          <span class="badge badge-blue">info</span>
          <span class="badge badge-yellow">warning</span>
          <span class="badge badge-red">error</span>
          <span class="badge badge-muted">muted</span>
          <span class="taxonomy-tag">taxonomy</span>
          <span class="taxonomy-tag taxonomy-warn">attention</span>
        </div>
      </article>

      <article class="lab-panel lab-wide">
        <h2>Dense Table</h2>
        <DataTable :value="tableRows" size="small" stripedRows class="lab-table">
          <Column field="ip" header="IP Address" />
          <Column header="Status">
            <template #body="{ data }"><StatusText :label="data.status.label" :className="data.status.className" /></template>
          </Column>
          <Column header="Type">
            <template #body="{ data }"><AddressTypePill :display="data.type" /></template>
          </Column>
          <Column field="hostname" header="Hostname" />
          <Column header="MAC">
            <template #body="{ data }"><span :class="{ 'cell-muted': !data.mac }">{{ data.mac || EMPTY_CELL }}</span></template>
          </Column>
          <Column field="seen" header="Last Seen" />
        </DataTable>
      </article>

      <article class="lab-panel">
        <h2>Doughnut Palette</h2>
        <div class="chart-wrap lab-chart">
          <Doughnut :data="doughnutData" :options="doughnutOptions" :plugins="[ChartDataLabels]" />
        </div>
      </article>

      <article class="lab-panel">
        <h2>Line Palette</h2>
        <div class="chart-wrap lab-chart">
          <Line :data="lineData" :options="lineOptions" />
        </div>
      </article>

      <div class="dashboard-content lab-wide lab-analytics-sample">
        <LineChartCard
          title="CPU Usage"
          :data="cpuLineData"
          :options="cpuLineOptions"
          emptyText="No CPU data in this range."
        />
      </div>

      <article class="lab-panel">
        <h2>Gauge States</h2>
        <div class="gauge-samples">
          <div v-for="gauge in gauges" :key="gauge.label" class="gauge-sample">
            <Doughnut :data="gaugeData(gauge.value)" :options="gaugeOptions" />
            <span>{{ gauge.label }}</span>
          </div>
        </div>
      </article>

      <article class="lab-panel">
        <h2>Theme Swatches</h2>
        <div class="swatch-grid">
          <button
            v-for="theme in themes"
            :key="theme.id"
            class="swatch-card"
            :class="{ active: themeStore.currentThemeId === theme.id }"
            @click="themeStore.applyTheme(theme.id)"
          >
            <span class="swatch-dot" :style="{ background: swatchFor(theme) }"></span>
            <span>{{ theme.name }}</span>
            <small>{{ theme.group }}</small>
          </button>
        </div>
      </article>

      <article class="lab-panel lab-wide">
        <h2>Contrast Checks</h2>
        <DataTable :value="contrastRows" size="small" stripedRows class="lab-table contrast-table">
          <Column header="Sample">
            <template #body="{ data }">
              <AddressTypePill v-if="data.addressType" :display="data.addressType" />
              <StatusText v-else-if="data.status" :label="data.status.label" :className="data.status.className" />
              <span v-else class="contrast-series-pill" :style="{ '--series-color': data.color }">
                {{ data.label }}
              </span>
            </template>
          </Column>
          <Column header="Color">
            <template #body="{ data }">
              <span class="contrast-color">
                <span class="contrast-swatch" :style="{ background: data.color }"></span>
                <code>{{ data.color }}</code>
              </span>
            </template>
          </Column>
          <Column field="cardRatio" header="Card" />
          <Column field="groundRatio" header="Ground" />
          <Column header="Text">
            <template #body="{ data }">
              <span class="contrast-grade" :class="data.textPass ? 'pass' : 'fail'">
                {{ data.textPass ? 'passes' : 'check' }}
              </span>
            </template>
          </Column>
          <Column header="Graphic">
            <template #body="{ data }">
              <span class="contrast-grade" :class="data.graphicPass ? 'pass' : 'fail'">
                {{ data.graphicPass ? 'passes' : 'check' }}
              </span>
            </template>
          </Column>
        </DataTable>
      </article>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { EMPTY_CELL } from '../utils/format.js';
import Select from '../ui/Select.js';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import { Doughnut, Line } from 'vue-chartjs';
import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import AddressTypePill from '../components/table/AddressTypePill.vue';
import LineChartCard from '../components/LineChartCard.vue';
import StatusText from '../components/table/StatusText.vue';
import { useThemeStore, themes, colorSwatches } from '../stores/theme.js';
import {
  chartColor,
  contrastRatio,
  cssVar,
  lineDataset,
  makeDoughnutOptions,
  makeDoughnutData,
  makeLineOptions,
} from '../utils/chart-config.js';
import {
  ADDRESS_TYPE_DYNAMIC_DHCP,
  ADDRESS_TYPE_GATEWAY,
  ADDRESS_TYPE_LOCKED,
  ADDRESS_TYPE_RESERVED_DHCP,
  ADDRESS_TYPE_ROGUE,
  ADDRESS_TYPE_STATIC_DNS,
  ADDRESS_TYPE_SYSTEM,
  ADDRESS_TYPE_UNKNOWN,
} from '../utils/ipLifecycleDisplay.js';
import '../assets/analytics-layout.css';

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler, ChartDataLabels);

const themeStore = useThemeStore();
const selectedTheme = ref(themeStore.currentThemeId);
const doughnutOptions = computed(() => makeDoughnutOptions());

const themeOptions = computed(() => themes.map(theme => ({
  label: `${theme.name} (${theme.group})`,
  value: theme.id,
})));

watch(selectedTheme, (value) => {
  if (value && value !== themeStore.currentThemeId) themeStore.applyTheme(value);
});

watch(() => themeStore.currentThemeId, (value) => {
  selectedTheme.value = value;
});

const addressTypes = [
  ADDRESS_TYPE_STATIC_DNS,
  ADDRESS_TYPE_DYNAMIC_DHCP,
  ADDRESS_TYPE_RESERVED_DHCP,
  ADDRESS_TYPE_ROGUE,
  ADDRESS_TYPE_GATEWAY,
  ADDRESS_TYPE_LOCKED,
  ADDRESS_TYPE_SYSTEM,
  ADDRESS_TYPE_UNKNOWN,
];

const statusStates = [
  { label: 'Online', className: 'state-ok' },
  { label: 'Offline', className: 'state-muted' },
  { label: 'Warning', className: 'state-warn' },
  { label: 'Error', className: 'state-err' },
  { label: 'Info', className: 'state-info' },
];

const semanticTokens = [
  { label: 'static DNS', token: '--cid-static-dns', addressType: ADDRESS_TYPE_STATIC_DNS },
  { label: 'dynamic DHCP', token: '--cid-dynamic-dhcp', addressType: ADDRESS_TYPE_DYNAMIC_DHCP },
  { label: 'reserved DHCP', token: '--cid-reserved-dhcp', addressType: ADDRESS_TYPE_RESERVED_DHCP },
  { label: 'system', token: '--cid-system', addressType: ADDRESS_TYPE_SYSTEM },
  { label: 'gateway', token: '--cid-gateway', addressType: ADDRESS_TYPE_GATEWAY },
  { label: 'locked', token: '--cid-locked', addressType: ADDRESS_TYPE_LOCKED },
  { label: 'rogue', token: '--cid-rogue', addressType: ADDRESS_TYPE_ROGUE },
  { label: 'unknown', token: '--cid-status-muted', addressType: ADDRESS_TYPE_UNKNOWN },
  { label: 'Online', token: '--cid-status-ok', status: statusStates[0] },
  { label: 'Warning', token: '--cid-status-warn', status: statusStates[2] },
  { label: 'Error', token: '--cid-status-err', status: statusStates[3] },
  { label: 'Info', token: '--cid-status-info', status: statusStates[4] },
  { label: 'Offline', token: '--cid-status-muted', status: statusStates[1] },
  { label: 'Chart 1', token: '--cid-chart-1' },
  { label: 'Chart 2', token: '--cid-chart-2' },
  { label: 'Chart 3', token: '--cid-chart-3' },
  { label: 'Chart 4', token: '--cid-chart-4' },
  { label: 'Chart 5', token: '--cid-chart-5' },
  { label: 'Chart 6', token: '--cid-chart-6' },
  { label: 'Chart 7', token: '--cid-chart-7' },
  { label: 'Chart 8', token: '--cid-chart-8' },
  { label: 'Chart 9', token: '--cid-chart-9' },
  { label: 'Chart 10', token: '--cid-chart-10' },
];

const tableRows = [
  { ip: '10.0.0.8', status: statusStates[0], type: ADDRESS_TYPE_STATIC_DNS, hostname: 'testerella', mac: 'BC:24:11:FD:8D:F5', seen: '11:21' },
  { ip: '10.0.0.27', status: statusStates[1], type: ADDRESS_TYPE_DYNAMIC_DHCP, hostname: 'withings-device', mac: '00:24:E4:EE:96:16', seen: 'yesterday' },
  { ip: '10.0.0.65', status: statusStates[2], type: ADDRESS_TYPE_RESERVED_DHCP, hostname: 'printer', mac: null, seen: EMPTY_CELL },
  { ip: '10.0.0.242', status: statusStates[3], type: ADDRESS_TYPE_ROGUE, hostname: 'unknown', mac: 'A4:CF:99:08:3A:CD', seen: 'now' },
  { ip: '10.0.0.255', status: statusStates[4], type: ADDRESS_TYPE_SYSTEM, hostname: 'broadcast', mac: null, seen: EMPTY_CELL },
];

const doughnutItems = [
  { label: 'DNS', count: 124 },
  { label: 'DHCP', count: 78 },
  { label: 'Blocked', count: 41 },
  { label: 'GeoIP', count: 23 },
  { label: 'Cache', count: 17 },
  { label: 'Other', count: 9 },
];
const doughnutData = computed(() => makeDoughnutData(doughnutItems, row => row.label));

const labels = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'];
const lineData = computed(() => ({
  labels,
  datasets: [
    lineDataset({ label: 'Queries', data: [12, 20, 42, 35, 55, 38], color: 1, fill: true }),
    lineDataset({ label: 'DHCP', data: [4, 6, 12, 8, 14, 9], color: 2 }),
    lineDataset({ label: 'Warnings', data: [0, 1, 3, 1, 4, 2], color: 'warn' }),
    lineDataset({ label: 'Errors', data: [0, 0, 1, 0, 2, 1], color: 'err' }),
  ],
}));
const lineOptions = computed(() => makeLineOptions({ yLabel: 'count' }));

const cpuLabels = ['11:00', '11:05', '11:10', '11:15', '11:20', '11:25', '11:30', '11:35', '11:40', '11:45', '11:50', '11:55'];
const cpuLineData = computed(() => ({
  labels: cpuLabels,
  datasets: [
    lineDataset({ label: 'CPU %', data: [7, 11, 9, 15, 26, 18, 22, 31, 24, 19, 14, 12], color: 7, fill: true }),
  ],
}));
const cpuLineOptions = computed(() => makeLineOptions({
  yLabel: '%',
  tooltipCallback: (ctx) => `CPU: ${ctx.parsed.y?.toFixed(1) ?? '-'}%`,
}));

const gauges = [
  { label: 'Healthy', value: 28 },
  { label: 'Warn', value: 68 },
  { label: 'Critical', value: 91 },
];

function gaugeData(value) {
  const clamped = Math.min(100, Math.max(0, value));
  const color = clamped > 80 ? chartColor('err') : clamped > 50 ? chartColor('warn') : chartColor('ok');
  return {
    labels: ['Used', 'Free'],
    datasets: [{ data: [clamped, 100 - clamped], backgroundColor: [color, chartColor('track')], borderWidth: 0 }],
  };
}

const gaugeOptions = {
  responsive: true,
  maintainAspectRatio: false,
  rotation: -90,
  circumference: 180,
  cutout: '72%',
  plugins: { legend: { display: false }, tooltip: { enabled: false }, datalabels: { display: false } },
};

function swatchFor(theme) {
  const nameKey = theme.name.toLowerCase();
  return colorSwatches[`${nameKey} ${theme.group}`] || colorSwatches[nameKey] || theme.customPrimary?.[300] || '#888';
}

function renderedColor(selector, property, fallback) {
  if (typeof document === 'undefined') return fallback;
  const element = document.querySelector(selector);
  return element ? getComputedStyle(element).getPropertyValue(property).trim() : fallback;
}

function formatRatio(value) {
  return value ? `${value.toFixed(2)}:1` : 'n/a';
}

const contrastRows = computed(() => {
  const currentTheme = themeStore.currentThemeId;
  const cardBg = renderedColor('.lab-panel', 'background-color', cssVar('--p-surface-card', '#1f2937'));
  const groundBg = renderedColor('.theme-lab', 'background-color', cssVar('--p-surface-ground', '#111827'));
  return semanticTokens.map((item) => {
    const { label, token } = item;
    const color = cssVar(token);
    const card = contrastRatio(color, cardBg);
    const ground = contrastRatio(color, groundBg);
    const textRatio = Math.min(card || 0, ground || 0);
    const graphicRatio = Math.min(card || 0, ground || 0);
    return {
      label,
      token,
      color,
      addressType: item.addressType,
      status: item.status,
      theme: currentTheme,
      cardRatio: formatRatio(card),
      groundRatio: formatRatio(ground),
      textPass: textRatio >= 4.5,
      graphicPass: graphicRatio >= 3,
    };
  });
});
</script>

<style scoped>
.theme-lab {
  padding: 1rem 2rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 100vh;
  background: var(--p-surface-ground);
}

.lab-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
}

.lab-header h1 {
  margin: 0;
  font-size: var(--app-fs-xl);
}

.lab-header p {
  margin: 0.25rem 0 0;
  color: var(--p-text-muted-color);
  font-size: var(--app-fs-sm);
}

.theme-select {
  min-width: 16rem;
}

.lab-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1rem;
}

.lab-panel {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem;
  min-width: 0;
}

.lab-wide {
  grid-column: 1 / -1;
}

.lab-panel h2 {
  margin: 0 0 0.75rem;
  font-size: var(--app-fs-md);
}

.lab-analytics-sample {
  min-width: 0;
}

.sample-row,
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.chip-row .status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  height: 28px;
  padding: 0 0.5rem;
  width: auto;
  min-width: 0;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  background: var(--p-surface-card);
  color: var(--p-text-color);
  line-height: 1;
  white-space: nowrap;
}

.chip-row .status-chip-label {
  font-size: var(--app-fs-xs);
  font-weight: 700;
}

.chip-row .card-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.chip-row .dot-up,
.chip-row .dot-ok {
  background: var(--cid-status-ok);
}

.chip-row .dot-warn {
  background: var(--cid-status-warn);
}

.chip-row .dot-down {
  background: var(--cid-status-err);
}

.chip-row .chip-ok {
  border-left: 3px solid var(--cid-status-ok);
}

.chip-row .chip-warn {
  border-left: 3px solid var(--cid-status-warn);
  color: var(--cid-status-warn);
}

.chip-row .chip-err {
  border-left: 3px solid var(--cid-status-err);
  color: var(--cid-status-err);
}

.lab-table {
  width: 100%;
}

.lab-chart {
  height: 260px;
}

.gauge-samples {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}

.gauge-sample {
  height: 130px;
  text-align: center;
  color: var(--cid-chart-text);
  font-size: var(--app-fs-xs);
}

.gauge-sample canvas {
  max-height: 100px;
}

.swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 0.5rem;
}

.swatch-card {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  row-gap: 0.1rem;
  align-items: center;
  text-align: left;
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 0.5rem;
  background: var(--p-surface-ground);
  color: var(--p-text-color);
  cursor: pointer;
}

.swatch-card.active {
  border-color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
}

.swatch-dot {
  grid-row: span 2;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--p-surface-border);
}

.swatch-card small {
  color: var(--p-text-muted-color);
  font-size: var(--app-fs-xs);
}

.contrast-color {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.contrast-swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid var(--p-surface-border);
}

.contrast-table code {
  color: var(--p-text-muted-color);
}

.contrast-series-pill {
  display: inline-flex;
  align-items: center;
  min-width: 70px;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--series-color) 16%, transparent);
  color: var(--series-color);
  font-size: var(--app-fs-xs);
  font-weight: 700;
  line-height: 1.4;
}

.contrast-grade {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: var(--app-fs-xs);
  font-weight: 700;
}

.contrast-grade.pass {
  background: color-mix(in srgb, var(--cid-status-ok) 16%, transparent);
  color: var(--cid-status-ok);
}

.contrast-grade.fail {
  background: color-mix(in srgb, var(--cid-status-warn) 16%, transparent);
  color: var(--cid-status-warn);
}
</style>
