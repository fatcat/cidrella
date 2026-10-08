import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AnomalyGauge from '../../../src/components/anomaly/AnomalyGauge.vue';

// The gauge is a half circle. Every arc on it spans at most 180 degrees, so
// the SVG large-arc flag must never be set; past the halfway mark it made the
// progress arc swing under the gauge instead of along the track.
describe('AnomalyGauge', () => {
  const arcs = (w) => w.findAll('path').map((p) => p.attributes('d'));

  it('keeps the progress arc on the track for a strongly anomalous score', () => {
    const w = mount(AnomalyGauge, { props: { score: -0.64, severity: 'high' } });
    const [track, progress] = arcs(w);
    for (const d of [track, progress]) expect(d).toMatch(/A 78 78 0 0 1 /);
    // Progress ends above the center line (y < cy) and past the midpoint.
    const end = progress.match(/1 ([\d.]+) ([\d.]+)$/);
    expect(Number(end[1])).toBeGreaterThan(100);
    expect(Number(end[2])).toBeLessThan(98);
    expect(w.text()).toContain('-0.64');
  });

  it('draws only a sliver for a score inside the baseline', () => {
    const w = mount(AnomalyGauge, { props: { score: 0.2 } });
    const [, progress] = arcs(w);
    const end = progress.match(/1 ([\d.]+) ([\d.]+)$/);
    expect(Number(end[1])).toBeLessThan(30);
  });
});
