import { describe, expect, it } from 'vitest';
import { skipAccessLog } from '../../../src/utils/access-log.js';

const call = (originalUrl, statusCode) => skipAccessLog({ originalUrl }, { statusCode });

describe('skipAccessLog', () => {
  it('leaves successful internal requests out of the access log', () => {
    expect(call('/api/internal/analytics/query', 200)).toBe(true);
  });

  it('still logs a failed internal request', () => {
    expect(call('/api/internal/analytics/query', 500)).toBe(false);
    expect(call('/api/internal/analytics/query', 401)).toBe(false);
  });

  it('logs every other request', () => {
    expect(call('/api/health/system', 200)).toBe(false);
    expect(call('/api/internalish', 200)).toBe(false);
  });
});
