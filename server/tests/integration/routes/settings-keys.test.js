import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

const { default: settingsRouter } = await import('../../../src/routes/settings.js');
const { default: request } = await import('supertest');

let tmpDir, app;

beforeAll(async () => { const s = await setupTestDb(); tmpDir = s.tmpDir; app = createTestApp(settingsRouter, '/api/settings'); });
afterAll(() => cleanupTestDb(tmpDir));

// These keys have authoritative routes that persist AND apply; the generic
// settings surface must refuse them so stored state can't diverge from the
// running config (see the SETTING_SCHEMA comment block).
const APPLY_COUPLED_KEYS = [
  'dns_upstream_servers',
  'dnssec_enabled',
  'dns_no_recursion',
  'forwarder_encryption',
  'forwarder_encrypted_upstreams',
  'rogue_dhcp_detection_enabled',
  'rogue_dhcp_probe_interval_min',
];

describe('PUT /api/settings/:key — apply-coupled keys are not editable', () => {
  for (const key of APPLY_COUPLED_KEYS) {
    it(`rejects ${key}`, async () => {
      const res = await request(app).put(`/api/settings/${key}`).send({ value: 'true' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be modified/);
    });
  }

  it('still accepts a schema key (control)', async () => {
    const res = await request(app).put('/api/settings/update_check_enabled').send({ value: 'true' });
    expect(res.status).toBe(200);
  });
});
