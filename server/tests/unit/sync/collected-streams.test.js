/**
 * What a member may upload: a count no minute could hold is refused, so no
 * retention window of rows can overflow a sum on the controller.
 */
import { describe, it, expect } from 'vitest';

const { acceptBatch, streamNamed } = await import('../../../src/sync/collected-streams.js');

describe('acceptBatch', () => {
  const stream = streamNamed('metrics_blocklist_hits');
  const now = Math.floor(Date.now() / 60_000) * 60;

  it('takes an ordinary count and refuses one no minute could hold', () => {
    const out = acceptBatch(
      stream,
      [
        [1, now, 'ads', 12],
        [2, now, 'ads', Number.MAX_SAFE_INTEGER],
        [3, now, 'ads', 1_000_000_001],
      ],
      0,
    );
    expect(out).toMatchObject({ taken: 1, refused: 2, position: 3 });
    expect(out.rows).toEqual([[now, 'ads', 12]]);
  });
});
