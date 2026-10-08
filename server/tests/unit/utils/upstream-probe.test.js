import { describe, it, expect } from 'vitest';
import { probeAddress } from '../../../src/utils/upstream-probe.js';

// The answer checks are in check-dns-providers.test.js and the connection
// handling in upstream-pool.test.js; this is what a probe reports.
describe('probeAddress', () => {
  it.each(['127.0.0.1', '::1'])(
    'reports a refused DoT connection at %s, with the time it took',
    async (address) => {
      const result = await probeAddress({
        provider: { hostname: 'localhost' },
        address,
        protocol: 'dot',
        timeoutMs: 400,
      });
      expect(result.connected).toBe(false);
      expect(result.problem).toBeTruthy();
      expect(result.ms).toBeGreaterThanOrEqual(0);
    },
  );
});
