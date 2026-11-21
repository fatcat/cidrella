// The member write gate (sync/write-gate.js): a controller lets everything
// through, a member lets through reads and the listed requests alone.
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { makeController, makeMember } from '../../helpers/member-mode.js';

const { default: request } = await import('supertest');
const { memberWriteGate, MEMBER_ALLOWED } = await import('../../../src/sync/write-gate.js');
const { setFenced, setHandoverFreeze } = await import('../../../src/sync/promotion-state.js');

let tmpDir;
let db;
let app;

const REFUSAL = {
  error: 'This is a member of ctl-1. Make changes there.',
  code: 'member_read_only',
};

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = express();
  // As index.js sets them, so the app routes the way the real one does.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.use(express.json());
  app.use(memberWriteGate);
  app.use((req, res) => res.json({ reached: true }));
});

afterEach(() => {
  makeController(db);
  setFenced(db, null);
  setHandoverFreeze(db, null);
});
afterAll(() => cleanupTestDb(tmpDir));

const send = (method, path, body) => request(app)[method.toLowerCase()](path).send(body);

// A path the entry's route would be asked with.
const samplePath = (entry) =>
  entry.prefix
    ? `${entry.prefix}anything/at/all`
    : entry.path.replace(/:key/, 'https_port').replace(/:\w+/g, '7');
const sampleMethod = (entry) => (entry.method === '*' ? 'POST' : entry.method);

describe('on a controller', () => {
  it('lets every write through', async () => {
    for (const [method, path] of [
      ['POST', '/api/subnets'],
      ['PUT', '/api/settings/ipv6_enabled'],
      ['DELETE', '/api/dns/zones/3'],
      ['PATCH', '/api/anything'],
    ]) {
      const res = await send(method, path, {});
      expect(res.body, `${method} ${path}`).toEqual({ reached: true });
    }
  });
});

describe('on a member', () => {
  it('refuses a write with the sentence and the code', async () => {
    makeMember(db);
    for (const [method, path] of [
      ['POST', '/api/subnets'],
      ['PUT', '/api/subnets/4'],
      ['DELETE', '/api/dns/zones/3'],
      ['PATCH', '/api/anything'],
      ['POST', '/api/auth/change-password'],
      ['PUT', '/api/auth/preferences'],
      ['POST', '/api/auth/totp/enable'],
      ['POST', '/api/operations/restore'],
      ['POST', '/api/dhcp/scopes/bulk-options/preview'],
      ['POST', '/api/no/such/route'],
    ]) {
      const res = await send(method, path, {});
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body).toEqual(REFUSAL);
    }
  });

  it('names the controller it was paired with', async () => {
    makeMember(db, { name: 'rack-a' });
    const res = await send('POST', '/api/subnets', {});
    expect(res.body.error).toBe('This is a member of rack-a. Make changes there.');
  });

  it('lets reads through, whatever the path', async () => {
    makeMember(db);
    for (const path of ['/api/subnets', '/api/settings', '/api/auth/me']) {
      expect((await request(app).get(path)).body).toEqual({ reached: true });
      expect((await request(app).head(path)).status).toBe(200);
      expect((await request(app).options(path)).status).toBe(200);
    }
  });

  it('leaves what is not the API alone', async () => {
    makeMember(db);
    expect((await send('POST', '/blocked', {})).body).toEqual({ reached: true });
  });

  it('lets every listed request through', async () => {
    makeMember(db);
    for (const entry of MEMBER_ALLOWED) {
      const res = await send(sampleMethod(entry), samplePath(entry), {});
      expect(res.body, `${entry.method} ${entry.path || entry.prefix}`).toEqual({ reached: true });
    }
  });

  it('lets any method through under the sync and instances prefixes', async () => {
    makeMember(db);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await send(method, '/api/sync/changes', {})).body).toEqual({ reached: true });
      expect((await send(method, '/api/instances/promote', {})).body).toEqual({ reached: true });
    }
    // The prefix is the directory, not a name that starts the same way.
    expect((await send('POST', '/api/syncopate', {})).status).toBe(409);
    expect((await send('POST', '/api/instances', {})).status).toBe(409);
  });

  it('matches the method of an entry, not just its path', async () => {
    makeMember(db);
    expect((await send('DELETE', '/api/auth/login', {})).status).toBe(409);
    expect((await send('PUT', '/api/dns/resolver-test/7', {})).status).toBe(409);
    expect((await send('DELETE', '/api/dns/resolver-test/7', {})).body).toEqual({ reached: true });
  });

  it('refuses another spelling of a listed path', async () => {
    makeMember(db);
    for (const path of [
      '/api/auth/login/',
      '/api/auth/LOGIN',
      '/API/auth/login/x',
      '/api/auth//login',
      '/api/auth/%6Cogin',
      '/api/auth/login/extra',
      '/api/dns/resolver-test/',
    ]) {
      const res = await send(path.includes('resolver') ? 'DELETE' : 'POST', path, {});
      // '/API/' is not under '/api/': the gate passes it and the app's
      // case-sensitive routing has no route for it.
      if (path.startsWith('/API/')) expect(res.body).toEqual({ reached: true });
      else expect(res.status, path).toBe(409);
    }
  });

  it('takes a settings write only for keys this box keeps', async () => {
    makeMember(db);
    const ok = { reached: true };
    expect((await send('PUT', '/api/settings/https_port', { value: 8443 })).body).toEqual(ok);
    expect((await send('PUT', '/api/settings/%68ttps_port', { value: 8443 })).body).toEqual(ok);
    expect((await send('PUT', '/api/settings/ipv6_enabled', { value: 'true' })).status).toBe(409);
    // A key the registry does not know is not this box's to write here.
    expect((await send('PUT', '/api/settings/made_up', { value: '1' })).status).toBe(409);
    expect((await send('PUT', '/api/settings/constructor', { value: '1' })).status).toBe(409);
    expect((await send('PUT', '/api/settings/%E0%A4%A', { value: '1' })).status).toBe(409);
    // The sub-router is not case sensitive, so this spelling reaches /bulk.
    expect(
      (await send('PUT', '/api/settings/BULK', { settings: { https_port: 8443 } })).status,
    ).toBe(409);

    const bulk = (settings) => send('PUT', '/api/settings/bulk', { settings });
    expect((await bulk({ https_port: 8443, backup_schedule: 'daily' })).body).toEqual(ok);
    expect((await bulk({ https_port: 8443, map_home: 'x' })).status).toBe(409);
    expect((await bulk({ password_min_length: 12 })).status).toBe(409);
  });

  it('takes the interface form without the IPv6 switch, and the setup markers without the password rule', async () => {
    makeMember(db);
    const ok = { reached: true };
    expect((await send('PUT', '/api/interfaces/config', { https_port: 8443 })).body).toEqual(ok);
    expect(
      (await send('PUT', '/api/interfaces/config', { https_port: 8443, ipv6_enabled: true }))
        .status,
    ).toBe(409);
    // DHCP stays the controller's.
    expect(
      (await send('PUT', '/api/interfaces/config', { https_port: 8443, dhcp_enabled: true }))
        .status,
    ).toBe(409);
    expect(
      (await send('PUT', '/api/interfaces/config', { https_port: 8443, dhcp_enabled: false })).body,
    ).toEqual(ok);
    // The form sends the switch with every save: unchanged, the save goes through.
    expect((await send('PUT', '/api/interfaces/config', { ipv6_enabled: false })).body).toEqual(ok);
    expect((await send('PUT', '/api/setup/state', { done: true })).body).toEqual(ok);
    expect(
      (await send('PUT', '/api/setup/state', { done: true, password_policy: { min_length: 12 } }))
        .status,
    ).toBe(409);
  });
});

describe('on a controller that is handing over', () => {
  it('refuses what a member refuses, naming the member it hands to', async () => {
    setHandoverFreeze(db, { to_instance_id: 'x', to_name: 'ctl-2', since: 'now' });
    const refused = await send('POST', '/api/subnets', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'The controller is being handed over to ctl-2.',
      code: 'controller_handover',
    });
    // Reads, the handover's own routes and what only touches this box go through.
    expect((await send('GET', '/api/subnets')).body).toEqual({ reached: true });
    expect((await send('POST', '/api/instances/promote/cancel')).body).toEqual({ reached: true });
    expect((await send('PUT', '/api/settings/https_port', {})).body).toEqual({ reached: true });
    expect((await send('PUT', '/api/settings/map_home', {})).status).toBe(409);
  });
});

describe('on a controller that was replaced', () => {
  it('refuses a write, naming who took over and what to do', async () => {
    // A fenced controller runs as a member that follows nobody (sync/mode.js).
    makeMember(db);
    db.prepare("DELETE FROM sync_state WHERE key = 'controller'").run();
    setFenced(db, { epoch: 2, by_instance_id: 'x', by_name: 'ctl-2', since: 'now' });
    const refused = await send('DELETE', '/api/dns/zones/3');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('controller_fenced');
    expect(refused.body.error).toBe(
      'ctl-2 took over as the controller, so this CIDRella no longer takes changes. ' +
        'Make them there, or join it from Settings > System > Instances.',
    );
    expect((await send('POST', '/api/instances/rejoin', {})).body).toEqual({ reached: true });
    expect((await send('GET', '/api/subnets')).body).toEqual({ reached: true });
  });
});

describe('the list', () => {
  it('gives every entry a method, a place and a reason', () => {
    for (const entry of MEMBER_ALLOWED) {
      expect(entry.method).toMatch(/^(POST|PUT|PATCH|DELETE|\*)$/);
      expect(Boolean(entry.path) !== Boolean(entry.prefix)).toBe(true);
      expect(entry.path || entry.prefix).toMatch(/^\/api\//);
      if (entry.prefix) expect(entry.prefix.endsWith('/')).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(5);
    }
  });
});
