// Shared chart constants for analytics pages

export const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

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
  return {
    labels: items.map(labelFn),
    datasets: [{
      data: items.map(valueFn),
      backgroundColor: items.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
}
