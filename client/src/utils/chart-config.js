// Shared chart constants for analytics pages.
//
// Doughnut palette is derived from --p-primary-color at render time:
// a categorical hue-stepped palette (H, H+30, H+60, …) so that re-theming
// the app re-colors the charts automatically. No hard-coded rainbow.

// Fallback used only if the CSS variable is missing or unparseable.
export const CHART_COLORS = [
  '#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444',
  '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#ec4899',
];

function parseColor(raw) {
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

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function makeChartPalette(count = 10, step = 30) {
  if (typeof window === 'undefined' || !document?.documentElement) return CHART_COLORS.slice(0, count);
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--p-primary-color');
  const rgb = parseColor(raw);
  if (!rgb) return CHART_COLORS.slice(0, count);
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return Array.from({ length: count }, (_, i) => {
    const hue = ((h + i * step) % 360 + 360) % 360;
    return `hsl(${hue.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
  });
}

export const RANGE_OPTIONS = [
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 4 hours', value: '4h' },
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 2 days', value: '2d' },
  { label: 'Last 1 week', value: '1w' },
];

export const DOUGHNUT_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '60%',
  plugins: {
    legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { enabled: true },
    datalabels: {
      color: '#fff',
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
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
      tooltip: tooltipCallback
        ? { mode: 'index', intersect: false, callbacks: { label: tooltipCallback } }
        : { mode: 'index', intersect: false },
      // ChartDataLabels is registered globally for doughnut charts (Dashboard).
      // Line charts should show values on hover (tooltip) only, not on every point.
      datalabels: { display: false },
    },
    scales: {
      x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
      y: {
        title: yLabel ? { display: true, text: yLabel } : undefined,
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
  const palette = makeChartPalette(Math.max(items.length, 1));
  return {
    labels: items.map(labelFn),
    datasets: [{
      data: items.map(valueFn),
      backgroundColor: items.map((_, i) => palette[i % palette.length]),
      borderWidth: 0,
    }],
  };
}
