import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StackedBar from '../../../src/components/StackedBar.vue';

const segments = [
  { key: 'a', label: 'Allowed', count: 300, color: 'info' },
  { key: 'b', label: 'Blocked', count: 100, color: 'warn' },
  { key: 'u', label: 'Unassigned', count: 50, hollow: true },
];

const widths = (w) => w.findAll('.bar span').map((s) => s.attributes('style'));

describe('StackedBar', () => {
  it('draws the solid segments in proportion to the total, hollow included', () => {
    const w = mount(StackedBar, { props: { segments, noun: 'queries' } });
    // 450 total: 300 and 100 drawn, the hollow 50 is the track.
    expect(widths(w).map((s) => /width: ([\d.]+)%/.exec(s)[1])).toEqual([
      '66.66666666666666',
      '22.22222222222222',
    ]);
    expect(w.find('.bar').attributes('aria-label')).toBe(
      '450 queries: Allowed 300, Blocked 100, Unassigned 50',
    );
    expect(w.findAll('.legend button').map((b) => b.text())).toEqual([
      'Allowed300',
      'Blocked100',
      'Unassigned50',
    ]);
  });

  it('hides a segment from the legend and re-proportions the rest', async () => {
    const w = mount(StackedBar, { props: { segments } });
    await w.findAll('.legend button')[0].trigger('click');
    expect(w.findAll('.legend button')[0].classes()).toContain('off');
    expect(widths(w).map((s) => /width: ([\d.]+)%/.exec(s)[1])).toEqual(['66.66666666666666']);
    expect(w.find('.bar').attributes('aria-label')).toBe('150 items: Blocked 100, Unassigned 50');
  });
});
