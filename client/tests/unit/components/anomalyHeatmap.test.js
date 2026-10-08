/**
 * The behavior timeline reads raw stored scores, where negative is anomalous.
 * Production's grid was white for a year because the old version clamped
 * negatives to zero and kept the highest score per cell.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AnomalyHeatmap from '../../../src/components/anomaly/AnomalyHeatmap.vue';

function row(daysAgo, hour, score) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return { window_start: d.toISOString(), anomaly_score: score };
}

const cells = (w) => w.findAll('rect').filter((r) => r.attributes('rx') === '2.5');
const fillAt = (w, dayIndex, hour) => cells(w)[dayIndex * 24 + hour].attributes('fill');

describe('AnomalyHeatmap', () => {
  it('draws a flagged (negative) window darker than a calm (positive) one', () => {
    const w = mount(AnomalyHeatmap, {
      props: { history: [row(0, 3, -0.45), row(0, 4, 0.2), row(1, 3, 0.1)] },
    });
    const flagged = fillAt(w, 1, 3);
    const calm = fillAt(w, 1, 4);
    expect(flagged).not.toBe(calm);
    // A positive score is the track color: nothing to see.
    expect(calm).toBe(fillAt(w, 0, 3));
    // Hours with no window at all are hatched, not colored.
    expect(fillAt(w, 0, 5)).toBe('url(#anomaly-heatmap-nodata)');
  });

  it('keeps the most anomalous window when several land in one hour', () => {
    const one = mount(AnomalyHeatmap, { props: { history: [row(0, 9, -0.5)] } });
    const both = mount(AnomalyHeatmap, {
      props: { history: [row(0, 9, -0.5), row(0, 9, 0.25)] },
    });
    expect(fillAt(both, 0, 9)).toBe(fillAt(one, 0, 9));
  });

  it('labels every day in full, including two-digit ones', () => {
    const w = mount(AnomalyHeatmap, { props: { history: [row(13, 1, 0.1), row(0, 1, 0.1)] } });
    const labels = w.findAll('text').map((t) => t.text());
    expect(labels).toContain('13d ago');
    expect(labels).toContain('today');
    // The label column is wide enough for the longest label.
    const label = w.findAll('text').find((t) => t.text() === '13d ago');
    expect(Number(label.attributes('x'))).toBeGreaterThanOrEqual(50);
  });
});
