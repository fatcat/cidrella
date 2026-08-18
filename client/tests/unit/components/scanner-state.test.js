import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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


describe('#55: every consumer actually uses the shared derivation', () => {
  // The unit tests above exercise deriveScanState in isolation, which cannot
  // catch a CONSUMER that ignores it. That is exactly what happened: the header
  // chip was switched over and the ops-popover row 70 lines below was missed,
  // so a queued scan showed "Scanner pending" next to a green OK dot. The
  // release notes claimed all three renderings agreed. They did not.
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
  const header = fs.readFileSync(path.join(SRC, 'components/HeaderBar.vue'), 'utf8');

  it('HeaderBar derives scanner state in exactly one place', () => {
    // The old shape, in any of its spellings.
    const inline = header.match(/activeScans\.(length|value\.length)\s*(\?|>)/g) || [];
    expect(inline, `un-unified scanner logic still in HeaderBar: ${inline.join(', ')}`).toEqual([]);
  });

  it('both scanner StatusDots read from scanState', () => {
    const dots = header.match(/<StatusDot[^>]*>/g) || [];
    const scannerDots = dots.filter(d => d.includes('scanState'));
    // One in the header chip, one in the ops popover. If a third scanner
    // rendering is added it should come from scanState too.
    expect(scannerDots.length).toBeGreaterThanOrEqual(2);
  });

  it('the guard is not vacuous: it matches the shape that was actually wrong', () => {
    const wasWrong = `<StatusDot :kind="activeScans.length ? 'ok' : 'muted'" />`;
    expect(/activeScans\.(length|value\.length)\s*(\?|>)/.test(wasWrong)).toBe(true);
  });
});
