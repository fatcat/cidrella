/**
 * What GET /api/features says about the instance: a member names its
 * controller and the URL of the controller's web UI, which the member's
 * header links to. An IPv6 controller address is bracketed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';
import { makeController, makeMember } from '../../helpers/member-mode.js';
import { writeSyncState } from '../../../src/sync/log.js';

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  const { default: features } = await import('../../../src/routes/features.js');
  app = createTestApp(features, '/api/features');
});

afterEach(() => makeController(db));
afterAll(() => cleanupTestDb(tmpDir));

const instance = async () => (await request(app).get('/api/features')).body.instance;

function followController(address, port) {
  const controller = makeMember(db, { name: 'ctl-1' });
  writeSyncState(db, 'controller', JSON.stringify({ ...controller, address, port }));
}

describe('controller_url', () => {
  it('is null on a controller', async () => {
    expect(await instance()).toMatchObject({ mode: 'controller', controller_url: null });
  });

  it('is the IPv4 controller address and its web port on a member', async () => {
    followController('192.0.2.10', 8443);
    expect(await instance()).toMatchObject({
      mode: 'member',
      controller_name: 'ctl-1',
      controller_url: 'https://192.0.2.10:8443',
    });
  });

  it('brackets an IPv6 controller address', async () => {
    followController('2001:db8::10', 8443);
    expect((await instance()).controller_url).toBe('https://[2001:db8::10]:8443');
  });

  it('leaves out the HTTPS port 443, both families (MEMBER-CONTROLLER-URL-PORT-01)', async () => {
    followController('192.0.2.10', 443);
    expect((await instance()).controller_url).toBe('https://192.0.2.10');
    followController('2001:db8::10', 443);
    expect((await instance()).controller_url).toBe('https://[2001:db8::10]');
  });

  it('is null when the stored controller has no address', async () => {
    followController(null, 443);
    expect((await instance()).controller_url).toBeNull();
  });
});
