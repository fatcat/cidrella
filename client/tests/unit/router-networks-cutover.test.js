import { describe, expect, it } from 'vitest';
import router from '../../src/router/index.js';

describe('network workspace route cutover', () => {
  it('keeps the workspace at the canonical route and the classic view at an explicit route', () => {
    const records = router.getRoutes();
    expect(records.find((record) => record.name === 'Networks')?.path).toBe('/networks');
    expect(records.find((record) => record.name === 'NetworksClassic')?.path).toBe(
      '/networks-classic',
    );
    expect(records.find((record) => record.path === '/subnets')?.redirect).toBe('/networks');
  });

  it('preserves preview query and hash state through the compatibility redirect', () => {
    const preview = router.getRoutes().find((record) => record.name === 'NetworksWorkspacePreview');
    expect(preview.redirect({ query: { view: 'dns', zone: '7' }, hash: '#records' })).toEqual({
      path: '/networks',
      query: { view: 'dns', zone: '7' },
      hash: '#records',
    });
  });
});
