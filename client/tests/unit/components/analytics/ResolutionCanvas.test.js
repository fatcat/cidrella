import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ResolutionCanvas from '../../../../src/components/analytics/ResolutionCanvas.vue';

const HOME = [-77, 39];
const make = (props) => mount(ResolutionCanvas, { props: { home: HOME, paused: true, ...props } });

describe('ResolutionCanvas', () => {
  it('is an image while it only shows the map', () => {
    const canvas = make().find('canvas');
    expect(canvas.attributes('role')).toBe('img');
    expect(canvas.attributes('tabindex')).toBeUndefined();
  });

  it('takes the keyboard when the globe turns or a pick is open', () => {
    for (const props of [{ mode: 'globe' }, { picking: true }]) {
      const canvas = make(props).find('canvas');
      expect(canvas.attributes('role')).toBe('application');
      expect(canvas.attributes('tabindex')).toBe('0');
      expect(canvas.attributes('aria-label')).toMatch(/Arrow keys/);
    }
  });

  it('picks home on Enter, or where the arrow keys moved the marker', async () => {
    for (const mode of ['map', 'globe']) {
      const w = make({ mode, picking: true });
      const canvas = w.find('canvas');
      await canvas.trigger('keydown', { key: 'Enter' });
      await canvas.trigger('keydown', { key: 'ArrowRight' });
      await canvas.trigger('keydown', { key: 'ArrowUp', shiftKey: true });
      await canvas.trigger('keydown', { key: 'Enter' });
      expect(w.emitted('pick')).toEqual([[HOME], [[HOME[0] + 2, HOME[1] + 10]]]);
    }
  });
});
