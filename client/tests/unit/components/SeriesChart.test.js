import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

vi.mock('vue-chartjs', () => ({
  Line: { name: 'Line', props: ['data'], template: '<div class="line-stub" />' },
}));

const { default: SeriesChart } = await import('../../../src/components/SeriesChart.vue');

const rows = [10, 30, 20, 40].map((v, i) => ({
  ts: 1789900000 + i * 60,
  v,
  gap: i % 2 ? v : null,
}));

function legend(wrapper) {
  return wrapper.findAll('.chip').map((c) => c.text().replace(/\s+/g, ' '));
}

describe('SeriesChart', () => {
  it('sums counts by default and totals them in the legend', () => {
    const w = mount(SeriesChart, {
      global: { plugins: [createPinia()] },
      props: { rows, series: [{ key: 'v', label: 'Queries', color: 'info' }], buckets: 2 },
    });
    expect(legend(w)).toEqual(['Queries 100']);
    expect(w.findComponent({ name: 'Line' }).props('data').datasets[0].data).toEqual([40, 60]);
  });

  it('averages, maxes and takes the latest for gauges, skipping nulls', () => {
    const w = mount(SeriesChart, {
      global: { plugins: [createPinia()] },
      props: {
        rows,
        unit: 'ms',
        buckets: 2,
        series: [
          { key: 'v', label: 'Avg', aggregate: 'avg', summary: 'avg' },
          { key: 'v', label: 'Max', aggregate: 'max', summary: 'max' },
          { key: 'gap', label: 'Latest', aggregate: 'avg', summary: 'latest' },
        ],
      },
    });
    expect(legend(w)).toEqual(['Avg 25ms', 'Max 40ms', 'Latest 40ms']);
    const data = w.findComponent({ name: 'Line' }).props('data').datasets;
    expect(data[0].data).toEqual([20, 30]);
    expect(data[1].data).toEqual([30, 40]);
    expect(data[2].data).toEqual([30, 40]);
  });

  it('draws nothing when the counts sum to zero, but draws a gauge at zero', () => {
    const zero = rows.map((r) => ({ ...r, v: 0 }));
    const counts = mount(SeriesChart, {
      global: { plugins: [createPinia()] },
      props: { rows: zero, noun: 'queries', series: [{ key: 'v', label: 'Queries' }] },
    });
    expect(counts.text()).toContain('No queries in this range.');
    expect(counts.find('.line-stub').exists()).toBe(false);
    const gauge = mount(SeriesChart, {
      global: { plugins: [createPinia()] },
      props: { rows: zero, series: [{ key: 'v', label: 'CPU', aggregate: 'avg', summary: 'avg' }] },
    });
    expect(gauge.find('.line-stub').exists()).toBe(true);
    const none = mount(SeriesChart, {
      global: { plugins: [createPinia()] },
      props: { rows: [], noun: 'samples', series: [{ key: 'v', label: 'CPU', summary: 'latest' }] },
    });
    expect(none.text()).toContain('No samples in this range.');
    expect(legend(none)).toEqual(['CPU —']);
  });
});
