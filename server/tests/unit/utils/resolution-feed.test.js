import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordResolution,
  resolutionSince,
  resetResolutionFeed,
  FEED_SIZE,
} from '../../../src/utils/resolution-feed.js';

const T = Date.parse('2026-10-09T12:00:00Z');
const answer = (country, at = T, name = 'a.example') =>
  recordResolution({ kind: 'answer', name, type: 'A', destination: { country, point: null } }, at);

beforeEach(() => resetResolutionFeed());

describe('the resolution feed', () => {
  it('returns only events after the cursor, oldest first', () => {
    answer('DE');
    answer('FR');
    const first = resolutionSince(0, { now: T });
    expect(first.events.map((e) => e.country)).toEqual(['DE', 'FR']);
    answer('JP');
    const next = resolutionSince(first.seq, { now: T });
    expect(next.events.map((e) => [e.seq, e.country])).toEqual([[3, 'JP']]);
  });

  it('keeps the newest events when there are more than the limit', () => {
    for (let i = 0; i < 10; i++) answer('DE', T, `n${i}.example`);
    const { events } = resolutionSince(0, { limit: 3, now: T });
    expect(events.map((e) => e.name)).toEqual(['n7.example', 'n8.example', 'n9.example']);
  });

  it(`wraps at ${FEED_SIZE} events`, () => {
    for (let i = 0; i < FEED_SIZE + 5; i++) answer('DE', T, `n${i}`);
    const { events, seq } = resolutionSince(0, { limit: FEED_SIZE * 2, now: T });
    expect([seq, events.length, events[0].name]).toEqual([FEED_SIZE + 5, FEED_SIZE, 'n5']);
  });

  it('starts over for a cursor from before a restart', () => {
    answer('DE');
    expect(resolutionSince(999, { now: T }).events).toHaveLength(1);
  });

  it('counts only the last minute, by kind and answer country', () => {
    answer('DE', T - 61_000);
    answer('DE', T - 10_000);
    answer('FR', T - 5_000);
    answer('FR', T - 4_000);
    recordResolution({ kind: 'geoip', name: 'x', destination: { country: 'CN' } }, T - 3_000);
    recordResolution({ kind: 'blocklist', name: 'ads.example' }, T - 2_000);
    const { summary } = resolutionSince(0, { now: T });
    expect(summary.kinds).toEqual({ answer: 3, geoip: 1, blocklist: 1 });
    expect(summary.countries).toBe(2);
    expect(summary.topCountries).toEqual([
      { country: 'FR', count: 2 },
      { country: 'DE', count: 1 },
    ]);
  });

  it('cuts long names and keeps a missing place as null', () => {
    recordResolution({ kind: 'blocklist', name: 'x'.repeat(400), type: 'AAAA' }, T);
    const [event] = resolutionSince(0, { now: T }).events;
    expect([event.name.length, event.country, event.point, event.type]).toEqual([
      253,
      null,
      null,
      'AAAA',
    ]);
  });
});
