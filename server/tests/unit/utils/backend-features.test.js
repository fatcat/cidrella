import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule({
    name: 'testd',
    capabilities: { 'dhcp-stats': true },
  }),
);

const { backend } = await import('../../../src/backends/index.js');
const { assertSupported, BackendFeatureError, BACKEND_FEATURE_UNSUPPORTED, refuseUnlessSupported } =
  await import('../../../src/utils/backend-features.js');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('refuseUnlessSupported', () => {
  it('lets a supported feature through without answering', () => {
    const res = fakeRes();
    expect(refuseUnlessSupported(res, 'dhcp-stats')).toBe(false);
    expect(res.body).toBe(null);
  });

  it('answers 409 with the code, the feature and the reason', () => {
    const res = fakeRes();
    expect(refuseUnlessSupported(res, 'dns-axfr-out')).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'Zone transfer to secondaries (AXFR/IXFR) is not available with testd.',
      code: BACKEND_FEATURE_UNSUPPORTED,
      feature: 'dns-axfr-out',
    });
  });

  it('adds the backend note to the reason', () => {
    const notes = backend.capabilityNotes;
    backend.capabilityNotes = () => ({ 'dns-axfr-out': 'testd serves no zone transfers.' });
    try {
      const res = fakeRes();
      refuseUnlessSupported(res, 'dns-axfr-out');
      expect(res.body.error).toBe(
        'Zone transfer to secondaries (AXFR/IXFR) is not available with testd. testd serves no zone transfers.',
      );
    } finally {
      backend.capabilityNotes = notes;
    }
  });

  it('throws for an id the catalog does not have', () => {
    expect(() => refuseUnlessSupported(fakeRes(), 'zone-transfers')).toThrow(
      'Unknown backend feature',
    );
  });
});

describe('assertSupported', () => {
  it('throws a 409 BackendFeatureError for a missing feature', () => {
    expect(() => assertSupported('dhcp-stats')).not.toThrow();
    let err;
    try {
      assertSupported('forensic-log');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BackendFeatureError);
    expect(err).toMatchObject({
      status: 409,
      code: BACKEND_FEATURE_UNSUPPORTED,
      feature: 'forensic-log',
    });
  });
});
