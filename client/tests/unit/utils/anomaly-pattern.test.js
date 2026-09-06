import { describe, it, expect } from 'vitest';
import { classifyClients, summaryCounts } from '../../../src/utils/anomaly-pattern.js';

function iso(daysAgo, hour = 2) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function event(client_ip, { daysAgo, hour = 2, score = 0.9, resolved = 0 } = {}) {
  return {
    client_ip,
    window_start: iso(daysAgo, hour),
    anomaly_score: score,
    severity: 'high',
    top_features: null,
    resolved,
    hostname: null,
  };
}

describe('classifyClients', () => {
  it('flags a currently-active, climbing score as escalating', () => {
    const events = [
      event('10.0.0.1', { daysAgo: 6, score: 0.2 }),
      event('10.0.0.1', { daysAgo: 3, score: 0.5 }),
      event('10.0.0.1', { daysAgo: 0, score: 0.9, resolved: 0 }),
    ];
    const [client] = classifyClients(events, []);
    expect(client.pattern).toBe('escalating');
  });

  it('flags a same-hour-every-day pattern as recurring', () => {
    const events = [0, 1, 2, 3, 4].map(d => event('10.0.0.2', { daysAgo: d, hour: 3, score: 0.6, resolved: d === 0 ? 0 : 1 }));
    const [client] = classifyClients(events, []);
    expect(client.pattern).toBe('recurring');
  });

  it('flags a resolved short spike as resolved, not escalating', () => {
    const events = [event('10.0.0.3', { daysAgo: 2, score: 0.85, resolved: 1 })];
    const [client] = classifyClients(events, []);
    expect(client.pattern).toBe('resolved');
  });

  it('carries learning clients through even with no events, but skips duplicates', () => {
    const events = [event('10.0.0.4', { daysAgo: 0, resolved: 0 })];
    const learning = [
      { client_ip: '10.0.0.5', hostname: null, training_rows: 6 },
      { client_ip: '10.0.0.4', hostname: null, training_rows: 6 },
    ];
    const clients = classifyClients(events, learning);
    expect(clients.map(c => c.client_ip).sort()).toEqual(['10.0.0.4', '10.0.0.5']);
    expect(clients.find(c => c.client_ip === '10.0.0.5').pattern).toBe('learning');
    expect(clients.find(c => c.client_ip === '10.0.0.4').pattern).not.toBe('learning');
  });

  it('sorts escalating clients ahead of recurring, resolved, and learning', () => {
    const events = [
      ...([0, 1, 2, 3].map(d => event('10.0.0.6', { daysAgo: d, hour: 3, score: 0.5, resolved: d === 0 ? 0 : 1 }))),
      event('10.0.0.7', { daysAgo: 6, score: 0.1 }),
      event('10.0.0.7', { daysAgo: 0, score: 0.95, resolved: 0 }),
    ];
    const learning = [{ client_ip: '10.0.0.8', training_rows: 2 }];
    const clients = classifyClients(events, learning);
    expect(clients.map(c => c.client_ip)).toEqual(['10.0.0.7', '10.0.0.6', '10.0.0.8']);
  });

  it('summaryCounts tallies each pattern bucket', () => {
    const clients = [{ pattern: 'escalating' }, { pattern: 'escalating' }, { pattern: 'learning' }];
    expect(summaryCounts(clients)).toMatchObject({ escalating: 2, learning: 1, recurring: 0, resolved: 0, flagged: 0 });
  });
});
