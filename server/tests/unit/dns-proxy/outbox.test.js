import { describe, expect, it } from 'vitest';
import { createOutbox } from '../../../src/dns-proxy/outbox.js';

describe('the outbox', () => {
  it('drops the oldest rows past its limit and counts them', () => {
    const outbox = createOutbox({ rows: 3, resolutions: 2, liveness: 2 });
    for (let i = 1; i <= 5; i++) outbox.row({ n: i });
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent[0]).toEqual({ type: 'rows', rows: [{ n: 3 }, { n: 4 }, { n: 5 }] });
    expect(outbox.dropped().rows).toBe(2);
  });

  it('sends each client address once, either family, and drops the oldest past its limit', () => {
    const outbox = createOutbox({ rows: 10, resolutions: 2, liveness: 2 });
    for (const ip of ['10.0.0.1', '10.0.0.1', 'fd00::1', '10.0.0.2']) outbox.client(ip);
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent).toEqual([{ type: 'liveness', clients: ['fd00::1', '10.0.0.2'] }]);
    expect(outbox.dropped().liveness).toBe(1);
  });

  it('keeps what it could not send, in order, for the next flush', () => {
    const outbox = createOutbox({ rows: 10, resolutions: 2, liveness: 2 });
    outbox.row({ n: 1 });
    outbox.row({ n: 2 });
    outbox.flush(() => false);
    outbox.row({ n: 3 });
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent[0].rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
