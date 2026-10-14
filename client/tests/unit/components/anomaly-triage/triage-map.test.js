import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TriageMap from '../../../../src/components/anomaly-triage/TriageMap.vue';

const point = (over) => ({
  id: 'a',
  name: 'nas',
  ip: '10.0.0.5',
  score: 0.1,
  threat: 0.2,
  severity: null,
  flagged24h: 0,
  actionable: false,
  color: '#888888',
  recent: false,
  stale: false,
  windowAge: '1h ago',
  ...over,
});
const dotOf = (wrapper) => wrapper.find('circle.mdot');

describe('TriageMap', () => {
  it('outlines a device calm now but flagged earlier, and keeps its fill grey', () => {
    const wrapper = mount(TriageMap, {
      props: { points: [point({ recent: true, flagged24h: 2, actionable: true })] },
    });
    const dot = dotOf(wrapper);
    expect(dot.attributes('fill')).toBe('#888888');
    expect(dot.attributes('stroke')).not.toBe('transparent');
    expect(dot.attributes('stroke-width')).toBe('2');
    expect(dot.find('title').text()).toContain('2 flagged in 24h');
    expect(wrapper.text()).toContain('Within baseline now, flagged in the last 24 hours');
  });

  it('fades a device whose newest window is old, and says how old', () => {
    const wrapper = mount(TriageMap, {
      props: { points: [point({ stale: true, windowAge: '9d ago' })] },
    });
    const dot = dotOf(wrapper);
    expect(dot.classes()).toContain('stale');
    expect(dot.attributes('fill-opacity')).toBe('0.3');
    expect(dot.find('title').text()).toContain('window 9d ago');
    expect(wrapper.text()).toContain('No window in the last day');
  });

  it('places a calm device left of center and a flagged one right of it', () => {
    const wrapper = mount(TriageMap, {
      props: { points: [point({ id: 'calm', score: 0.2 }), point({ id: 'hot', score: -0.2 })] },
    });
    const [calm, hot] = wrapper.findAll('circle.mdot').map((c) => Number(c.attributes('cx')));
    const center = (52 + (760 - 18)) / 2;
    expect(calm).toBeLessThan(center);
    expect(hot).toBeGreaterThan(center);
  });
});
