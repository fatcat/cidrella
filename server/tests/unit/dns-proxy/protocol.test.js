import { describe, expect, it } from 'vitest';
import {
  encode,
  createDecoder,
  MAX_LINE_BYTES,
  metricsToWire,
  metricsFromWire,
} from '../../../src/dns-proxy/protocol.js';

function decoder() {
  const messages = [];
  const errors = [];
  const feed = createDecoder(
    (m) => messages.push(m),
    (e) => errors.push(e),
  );
  return { feed, messages, errors };
}

describe('the proxy protocol', () => {
  it('reads one message per line, across chunks however they split', () => {
    const { feed, messages, errors } = decoder();
    const wire = encode({ type: 'hello', v: 1 }) + encode({ type: 'drain', id: 7 });
    feed(Buffer.from(wire.slice(0, 5)));
    feed(Buffer.from(wire.slice(5, 22)));
    feed(Buffer.from(wire.slice(22)));
    expect(messages).toEqual([
      { type: 'hello', v: 1 },
      { type: 'drain', id: 7 },
    ]);
    expect(errors).toEqual([]);
  });

  it('keeps a character whole when a read splits it', () => {
    const { feed, messages } = decoder();
    const wire = Buffer.from(encode({ type: 'rows', rows: [{ domain: 'bücher.example' }] }));
    const split = wire.indexOf(Buffer.from('ü')) + 1;
    feed(wire.subarray(0, split));
    feed(wire.subarray(split));
    expect(messages[0].rows[0].domain).toBe('bücher.example');
  });

  it('gives up on a line that is not a message, and reads nothing after it', () => {
    const { feed, messages, errors } = decoder();
    feed('not json\n' + encode({ type: 'hello' }));
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([]);
  });

  it('gives up on a line longer than the limit', () => {
    const { feed, errors } = decoder();
    feed('x'.repeat(MAX_LINE_BYTES + 1));
    expect(errors[0].message).toMatch(/passed/);
  });

  it('carries the counters, Maps and all', () => {
    const metrics = {
      blocklistHits: { delta: 2, categoryHits: new Map([['ads', 2]]) },
      blockedDelta: 1,
      countryHits: new Map([['RU', 1]]),
      performance: { queryCount: 3 },
    };
    const back = metricsFromWire(JSON.parse(JSON.stringify(metricsToWire(metrics))));
    expect(back).toEqual(metrics);
  });
});
