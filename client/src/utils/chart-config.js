// Shared chart constants for analytics pages. Colors are app-semantic CSS
// tokens, not raw PrimeVue theme hues, so charts remain readable and
// category identity stays stable across theme changes.

import { ref } from 'vue';

export const chartThemeVersion = ref(0);

function pokeChartTheme() {
  chartThemeVersion.value += 1;
}

if (typeof window !== 'undefined') {
  window.addEventListener('ipam:theme-change', pokeChartTheme);
  window.addEventListener('load', pokeChartTheme, { once: true });
  requestAnimationFrame(() => requestAnimationFrame(pokeChartTheme));
}

export const CHART_COLORS = [
  '#2563eb', '#16a34a', '#9333ea', '#d97706', '#dc2626',
  '#0891b2', '#4f46e5', '#be123c', '#65a30d', '#0f766e',
];

export function cssVar(name, fallback = '') {
  chartThemeVersion.value;
  if (typeof window === 'undefined' || !document?.documentElement) return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function cssNumber(name, fallback) {
  const raw = cssVar(name, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseColor(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function withAlpha(color, alpha) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function luminance([r, g, b]) {
  const convert = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [convert(r), convert(g), convert(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrastRatio(foreground, background) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const light = Math.max(luminance(fg), luminance(bg));
  const dark = Math.min(luminance(fg), luminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

export function readableTextColor(background) {
  const blackRatio = contrastRatio('#111827', background) || 0;
  const whiteRatio = contrastRatio('#ffffff', background) || 0;
  return blackRatio >= whiteRatio ? '#111827' : '#ffffff';
}

export function chartColor(indexOrName, fallback = null) {
  if (typeof indexOrName === 'number') {
    const index = ((indexOrName - 1) % CHART_COLORS.length + CHART_COLORS.length) % CHART_COLORS.length;
    return cssVar(`--cid-chart-${index + 1}`, fallback || CHART_COLORS[index]);
  }
  const semantic = {
    ok: ['--cid-status-ok', '#16a34a'],
    warn: ['--cid-status-warn', '#d97706'],
    err: ['--cid-status-err', '#dc2626'],
    info: ['--cid-status-info', '#2563eb'],
    muted: ['--cid-status-muted', '#64748b'],
    track: ['--cid-gauge-track', 'rgba(100, 116, 139, 0.18)'],
    text: ['--cid-chart-text', '#64748b'],
    grid: ['--cid-chart-grid', 'rgba(100, 116, 139, 0.22)'],
  };
  const [token, defaultColor] = semantic[indexOrName] || [];
  return token ? cssVar(token, fallback || defaultColor) : (fallback || CHART_COLORS[0]);
}

export function chartFill(indexOrName, alpha = 0.15) {
  return withAlpha(chartColor(indexOrName), alpha);
}

export function makeChartPalette(count = 10) {
  return Array.from({ length: count }, (_, i) => chartColor(i + 1));
}

export function lineDataset({ label, data, color = 1, fill = false, alpha = null, ...rest }) {
  const borderColor = chartColor(color);
  const fillAlpha = alpha ?? cssNumber('--cid-chart-line-fill-alpha', 0.15);
  const borderWidth = cssNumber('--cid-chart-line-width', 2);
  return {
    label,
    data,
    borderColor,
    backgroundColor: fill ? chartFill(color, fillAlpha) : undefined,
    pointBackgroundColor: borderColor,
    pointBorderColor: borderColor,
    borderWidth,
    fill,
    tension: 0.3,
    pointRadius: 0,
    ...rest,
  };
}

export const RANGE_OPTIONS = [
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 4 hours', value: '4h' },
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 2 days', value: '2d' },
  { label: 'Last 1 week', value: '1w' },
];

const LEGEND_LABELS = {
  usePointStyle: true,
  pointStyle: 'circle',
  boxWidth: 18,
  boxHeight: 8,
  padding: 18,
  color: () => chartColor('text'),
};

export const DOUGHNUT_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '60%',
  plugins: {
    legend: {
      position: 'right',
      labels: {
        ...LEGEND_LABELS,
      },
    },
    tooltip: { enabled: true },
    datalabels: {
      color: (ctx) => readableTextColor(ctx.dataset.backgroundColor?.[ctx.dataIndex] || '#000000'),
      font: { weight: 'bold', size: 11 },
      formatter: (value, ctx) => {
        const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
        const pct = ((value / total) * 100).toFixed(1);
        return pct >= 5 ? `${pct}%` : '';
      },
    },
  },
};

/**
 * Build a Chart.js options object for a line chart.
 *
 * @param {object} opts
 * @param {string}   [opts.yLabel]          - Y-axis title text
 * @param {Function} [opts.tooltipCallback] - optional label callback for tooltip
 * @param {boolean}  [opts.stacked=false]   - whether Y axis should stack datasets
 * @param {object}   [opts.extraScales]     - additional scale definitions merged into scales
 */
export function makeLineOptions({ yLabel, tooltipCallback, stacked = false, extraScales } = {}) {
  const textColor = chartColor('text');
  const gridColor = chartColor('grid');
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { ...LEGEND_LABELS, color: textColor } },
      tooltip: tooltipCallback
        ? { mode: 'index', intersect: false, callbacks: { label: tooltipCallback } }
        : { mode: 'index', intersect: false },
      // ChartDataLabels is registered globally for doughnut charts (Dashboard).
      // Line charts should show values on hover (tooltip) only, not on every point.
      datalabels: { display: false },
    },
    scales: {
      x: { ticks: { maxTicksLimit: 12, maxRotation: 0, color: textColor }, grid: { display: false } },
      y: {
        title: yLabel ? { display: true, text: yLabel, color: textColor } : undefined,
        ticks: { color: textColor },
        grid: { color: gridColor },
        beginAtZero: true,
        stacked,
      },
      ...(extraScales || {}),
    },
  };
}

/**
 * Build a Chart.js data object for a doughnut chart.
 *
 * @param {Array}    items     - source data items
 * @param {Function} labelFn  - item → label string
 * @param {Function} [valueFn] - item → numeric value (defaults to r => Number(r.count))
 */
export function makeDoughnutData(items, labelFn, valueFn = r => Number(r.count)) {
  const alpha = cssNumber('--cid-chart-doughnut-alpha', 0.62);
  const palette = Array.from({ length: Math.max(items.length, 1) }, (_, i) => chartFill(i + 1, alpha));
  return {
    labels: items.map(labelFn),
    datasets: [{
      data: items.map(valueFn),
      backgroundColor: items.map((_, i) => palette[i % palette.length]),
      borderWidth: 0,
    }],
  };
}
