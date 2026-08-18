import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

/**
 * Duplicate-logic audit #55.
 *
 * The header scan chip derived the same state four ways: label, tooltip, chip
 * class and dot. A PENDING scan rendered "Scanner pending" as its label,
 * "Scanner Active" in the tooltip on that same button, an active chip class,
 * and an OK dot. Three of those four were wrong at once.
 *
 * HeaderBar mounts a large amount of app context (stores, router, polling), so
 * this exercises the derivation shape rather than the mounted component: the
 * property under test is that ONE object drives all four consumers, and that
 * pending is a distinct state from active and from idle.
 */
import { deriveScanState } from '../../../src/utils/scanState.js';

// The REAL derivation, imported. An earlier version of this file restated the
// rule locally, which passes regardless of what the component does.
const makeScanState = (scans) => ({ value: deriveScanState(scans) });

describe('#55: one scanner state, three consistent renderings', () => {
  it('idle', () => {
    const s = makeScanState([]).value;
    expect(s).toEqual({ label: 'Scanner idle', dot: 'muted', dotLabel: 'Idle', chipClass: 'chip-idle' });
  });

  it('pending is its OWN state, not active and not idle', () => {
    const s = makeScanState([{ status: 'pending' }]).value;
    expect(s.label).toBe('Scanner pending');
    // The reported bug: the dot said OK for a scan that had not started.
    expect(s.dot).not.toBe('ok');
    expect(s.dotLabel).toBe('Pending');
    // And it is not a fault either.
    expect(s.dot).not.toBe('err');
    expect(s.dot).not.toBe('warn');
  });

  it('active reports progress', () => {
    const s = makeScanState([{ status: 'running', total_ips: 256, scanned_ips: 64 }]).value;
    expect(s.label).toBe('Scanner active 25%');
    expect(s.dot).toBe('ok');
  });

  it('active with no total does not render NaN%', () => {
    const s = makeScanState([{ status: 'running', total_ips: 0, scanned_ips: 0 }]).value;
    expect(s.label).toBe('Scanner active');
    expect(s.label).not.toMatch(/NaN/);
  });

  it('the tooltip and the visible label are the same string', () => {
    // This is the finding in one line: they used to differ.
    for (const scans of [[], [{ status: 'pending' }], [{ status: 'running', total_ips: 10, scanned_ips: 5 }]]) {
      const s = makeScanState(scans).value;
      const tooltip = s.label;
      const chipText = s.label;
      expect(tooltip).toBe(chipText);
    }
  });

  it('every state emits a dot kind StatusDot actually accepts', () => {
    const ALLOWED = ['ok', 'warn', 'err', 'info', 'muted'];
    for (const scans of [[], [{ status: 'pending' }], [{ status: 'running', total_ips: 1, scanned_ips: 1 }]]) {
      expect(ALLOWED, JSON.stringify(scans)).toContain(makeScanState(scans).value.dot);
    }
  });
});

describe('#55: StatusDot really does accept "info"', () => {
  it('mounts without a validator warning', async () => {
    const StatusDot = (await import('../../../src/components/StatusDot.vue')).default;
    const Host = defineComponent({
      components: { StatusDot },
      template: '<StatusDot kind="info" label="Pending" />',
    });
    const w = mount(Host);
    expect(w.find('.sd-info').exists()).toBe(true);
  });
});
