/**
 * formatRelativeTime, the single relative-time formatter.
 *
 * There were three: HeaderBar.vue, Anomalies.vue and (as formatRelative)
 * UpdatePanel.vue. Only one carried the finite guard, so the other two rendered
 * the literal string "NaNd ago" for a timestamp that does not parse, and
 * Anomalies feeds it from daemon fields written by the Python anomaly sidecar.
 * They also disagreed on the missing-value placeholder.
 *
 * See REVIEW.md, duplicate-logic audit #42.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../../../src/utils/dateFormat.js';

const NOW = new Date('2026-08-07T12:00:00.000Z').getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();

afterEach(() => vi.useRealTimers());

function atNow() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

describe('formatRelativeTime', () => {
  it('walks the buckets', () => {
    atNow();
    expect(formatRelativeTime(ago(5 * 1000))).toBe('just now');
    expect(formatRelativeTime(ago(59 * 1000))).toBe('just now');
    expect(formatRelativeTime(ago(60 * 1000))).toBe('1m ago');
    expect(formatRelativeTime(ago(59 * 60 * 1000))).toBe('59m ago');
    expect(formatRelativeTime(ago(60 * 60 * 1000))).toBe('1h ago');
    expect(formatRelativeTime(ago(23 * 60 * 60 * 1000))).toBe('23h ago');
    expect(formatRelativeTime(ago(24 * 60 * 60 * 1000))).toBe('1d ago');
    expect(formatRelativeTime(ago(30 * 60 * 60 * 1000))).toBe('1d ago');
  });

  it('never renders NaN for an unparseable timestamp', () => {
    // The actual bug: two of the three copies lacked the finite guard, so this
    // rendered the literal "NaNd ago" in the UI.
    atNow();
    for (const bad of ['2026-13-45', 'not-a-date', '2026-08-07T99:99:99Z', {}, []]) {
      const out = formatRelativeTime(bad);
      expect(out, `input ${JSON.stringify(bad)}`).not.toContain('NaN');
      expect(out).toBe('—');
    }
  });

  it('uses the shared empty placeholder for missing values', () => {
    // UpdatePanel's copy returned an empty string here, so the same absent value
    // rendered as blank in one place and as the placeholder in another.
    for (const empty of [null, undefined, '', 0]) {
      expect(formatRelativeTime(empty)).toBe('—');
    }
  });

  it('does not go negative for a future timestamp', () => {
    atNow();
    expect(formatRelativeTime(new Date(NOW + 60_000).toISOString())).toBe('just now');
  });
});
