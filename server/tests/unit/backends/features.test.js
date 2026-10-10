import { describe, it, expect } from 'vitest';
import {
  FEATURES,
  FEATURE_IDS,
  declareSupport,
  featureIdsForRole,
} from '../../../src/backends/features.js';
import { ROLES } from '../../../src/backends/contract.js';

describe('feature catalog', () => {
  it('has unique ids, a known role and a verdict on every entry', () => {
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
    for (const f of FEATURES) {
      expect(ROLES, f.id).toContain(f.role);
      expect(['yes', 'maybe'], f.id).toContain(f.verdict);
      expect(f.label, f.id).toBeTruthy();
    }
  });

  it('declares every feature of the given roles, false unless listed', () => {
    const caps = declareSupport(['ra'], ['ra']);
    expect(Object.keys(caps).sort()).toEqual(featureIdsForRole('ra').sort());
    expect(caps.ra).toBe(true);
    expect(caps['ra-tuning']).toBe(false);
    expect(declareSupport(['ra'], { ra: false }).ra).toBe(false);
  });

  it('refuses an id outside the catalog or the roles', () => {
    expect(() => declareSupport(['ra'], ['zone-transfers'])).toThrow('zone-transfers');
    expect(() => declareSupport(['ra'], ['dhcp-stats'])).toThrow('dhcp-stats');
  });
});
