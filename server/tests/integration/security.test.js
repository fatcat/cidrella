/**
 * Security regression tests, v0.4.14 pentest findings that v0.4.15 closed.
 *
 * Covers CRITICAL / HIGH / MEDIUM / LOW items from the three security agents
 * (api-security-tester, auth-security-tester, injection-logic-tester). Each
 * test names the finding it guards against and fails fast if the fix regresses.
 *
 * Intentionally SKIPPED (not worth automating):
 *   - L1 bcrypt timing enum  → flaky, millisecond-scale
 *   - Process-crash negative assertion → needs subprocess harness
 *   - H8 authenticated write rate limiter → lives in index.js, not a router,
 *     and the 300/min cap is awkward to time in a test
 *   - TLS / security-headers → covered by helmet; re-implementing the
 *     helmet config in a test helper is more fragile than it's worth.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import bcrypt from 'bcryptjs';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';
import { createTestApp, createMultiRouterApp } from '../helpers/test-app.js';
import { getDb } from '../../src/db/init.js';

vi.mock('../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    applyInterfaceConfig: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    signalDnsmasq: vi.fn(),
    restartDnsmasq: vi.fn(),
  };
});
vi.mock('../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateDhcpConfigs: vi.fn(),
    startLeaseWatcher: vi.fn(),
  };
});

const { default: authRouter }    = await import('../../src/auth/routes.js');
const { default: setupRouter }   = await import('../../src/routes/setup.js');
const { default: subnetRouter }  = await import('../../src/routes/subnets.js');
const { default: dnsRouter }     = await import('../../src/routes/dns.js');
const { default: dhcpRouter }    = await import('../../src/routes/dhcp.js');
const { default: settingsRouter } = await import('../../src/routes/settings.js');
const { default: piholeRouter }  = await import('../../src/routes/pihole.js');
const { default: blocklistRouter } = await import('../../src/routes/blocklists.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;              // multi-router app with fake admin (matches prod routers that need req.user)
let noAuthApp;        // no fake-user middleware, for pre-auth surface (setup) and the auth router

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;

  // Seed a known-password user so the rate-limiter tests can also exercise
  // the success path without guessing the auto-generated admin password.
  const db = getDb();
  const hash = bcrypt.hashSync('TestUserPw123', 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)"
  ).run('sectest', hash);

  app = createMultiRouterApp([
    { prefix: '/api/subnets',    router: subnetRouter },
    { prefix: '/api/dns',        router: dnsRouter },
    { prefix: '/api/dhcp',       router: dhcpRouter },
    { prefix: '/api/settings',   router: settingsRouter },
    { prefix: '/api/pihole',     router: piholeRouter },
    { prefix: '/api/blocklists', router: blocklistRouter },
  ]);

  // Mirror the production 4xx/5xx handler so tests can assert that body-parse
  // errors collapse to "Invalid JSON body" (v0.4.15 H6 fix).
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const status = err.status || 500;
    if (status >= 500) return res.status(status).json({ error: 'Internal server error' });
    res.status(status).json({ error: err.message || 'Bad request' });
  });
  // JSON 404 fallback, matches the production mount order.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Pre-auth app (no fake user) for the auth router + setup.
  noAuthApp = express();
  noAuthApp.use(express.json());
  noAuthApp.use('/api/auth', authRouter);
  noAuthApp.use('/api/setup', setupRouter);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// -----------------------------------------------------------------------------
// C1, Unauthenticated crash-DoS via non-string password
// -----------------------------------------------------------------------------

describe('C1: bcrypt crash DoS, non-string password/username rejected with 400', () => {
  it.each([
    ['password as object', { username: 'sectest', password: {} }],
    ['password as array',  { username: 'sectest', password: [] }],
    ['password as number', { username: 'sectest', password: 1234 }],
    ['password as null',   { username: 'sectest', password: null }],
    ['password with $ne',  { username: 'sectest', password: { $ne: null } }],
    ['username as object', { username: {}, password: 'x' }],
    ['username as array',  { username: ['sectest'], password: 'x' }],
    ['username as number', { username: 123, password: 'x' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await request(noAuthApp).post('/api/auth/login').send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Must not leak a bcrypt/sqlite stack trace text
    expect(JSON.stringify(res.body)).not.toMatch(/Illegal arguments|bind parameter|toLowerCase|bcrypt/i);
  });
});

// -----------------------------------------------------------------------------
// H1, Unauthenticated setup takeover
// -----------------------------------------------------------------------------

describe('H1: setup is closed once any user exists', () => {
  it('GET /api/setup/status returns setup_required:false when users exist', async () => {
    const res = await request(noAuthApp).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.setup_required).toBe(false);
  });

  it('POST /api/setup returns 409 when users exist', async () => {
    const res = await request(noAuthApp).post('/api/setup').send({ username: 'pwn', password: 'Pwnd123!' });
    expect(res.status).toBe(409);
  });

  it('POST /api/setup with {skip:true} returns 409 when users exist', async () => {
    const res = await request(noAuthApp).post('/api/setup').send({ skip: true });
    expect(res.status).toBe(409);
  });
});

// -----------------------------------------------------------------------------
// L6, unknown-user login is audited
// -----------------------------------------------------------------------------

describe('L6: unknown-user login attempts audited', () => {
  it('logs reason:unknown_user on non-existent username', async () => {
    const marker = 'nosuchuser_' + Date.now();
    const res = await request(noAuthApp).post('/api/auth/login').send({ username: marker, password: 'whatever' });
    expect(res.status).toBe(401);

    const row = getDb().prepare(
      "SELECT details FROM audit_log WHERE action='login_failed' ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row).toBeDefined();
    const parsed = JSON.parse(row.details);
    expect(parsed.reason).toBe('unknown_user');
    expect(parsed.attempted_username).toBe(marker);
  });
});

// -----------------------------------------------------------------------------
// L2, logout invalidates the caller's token (via updated_at bump)
// -----------------------------------------------------------------------------

describe('L2: logout invalidates the caller\'s token', () => {
  it('POST /api/auth/logout returns 200 and records an audit entry', async () => {
    const db = getDb();
    // createTestApp injects req.user={id:1} so this exercises the logout path.
    const miniApp = createTestApp(authRouter, '/api/auth');
    const res = await request(miniApp).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Audit row confirms the mechanism fired, the actual updated_at bump
    // happens via SQL we can't easily diff at sub-second resolution.
    const row = db.prepare(
      "SELECT * FROM audit_log WHERE user_id = 1 AND action = 'logout' ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// C2, PTR record name config injection
// -----------------------------------------------------------------------------

describe('C2/H2: DNS record config injection', () => {
  let fwdZone;
  let revZone;

  beforeAll(async () => {
    const f = await request(app).post('/api/dns/zones').send({ name: 'injtest.example', type: 'forward' });
    fwdZone = f.body;
    const r = await request(app).post('/api/dns/zones').send({ name: '99.88.10.in-addr.arpa', type: 'reverse' });
    revZone = r.body;
  });

  it('rejects PTR with newline in name (C2)', async () => {
    const res = await request(app).post(`/api/dns/zones/${revZone.id}/records`).send({
      name: '5\naddress=/evilpwn.com/6.6.6.6\n#',
      type: 'PTR',
      value: 'host.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('rejects PTR with comma in name', async () => {
    const res = await request(app).post(`/api/dns/zones/${revZone.id}/records`).send({
      name: '5,x', type: 'PTR', value: 'host.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('rejects PTR with non-numeric name', async () => {
    const res = await request(app).post(`/api/dns/zones/${revZone.id}/records`).send({
      name: 'hello', type: 'PTR', value: 'host.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('rejects TXT value with LF newline (H2)', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'txt1', type: 'TXT', value: 'a\naddress=/evil.example/6.6.6.6\n'
    });
    expect(res.status).toBe(400);
  });

  it('rejects TXT value with CR', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'txt2', type: 'TXT', value: 'a\rb'
    });
    expect(res.status).toBe(400);
  });

  it('rejects CNAME self-loop (L5)', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'loop', type: 'CNAME', value: 'loop.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('accepts a CNAME alias entered as an FQDN inside the zone', async () => {
    const a = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'target-host', type: 'A', value: '10.99.88.11'
    });
    expect(a.status).toBe(201);

    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'alias-fqdn.injtest.example',
      type: 'CNAME',
      value: 'target-host.injtest.example'
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('alias-fqdn');
    expect(res.body.value).toBe('target-host.injtest.example');
  });

  // CRITICAL (v0.4.16-pre.3 pentest): the reverse-zone name branch skipped all
  // validation, so a newline-laden `.in-addr.arpa` name smuggled arbitrary
  // dnsmasq directives (address=/hijack/6.6.6.6) into conf.d and hijacked DNS.
  it('rejects a reverse zone name with an injected directive (config injection)', async () => {
    const res = await request(app).post('/api/dns/zones').send({
      name: '1.2.10.foo,ok\naddress=/hijack.pentest.test/6.6.6.6\n#z.in-addr.arpa',
      type: 'reverse'
    });
    expect(res.status).toBe(400);
  });

  // The injection vector is control/delimiter characters in the name, since
  // that's what breaks out of the config line. A benign non-reverse domain
  // like 'evil.in-addr.arpa' is accepted (isValidDomain passes) and is
  // harmless, matching pre-existing behavior, so it's not in this list.
  it('rejects reverse zone names carrying delimiter/control characters', async () => {
    for (const name of ['5,x.in-addr.arpa', '1 2.in-addr.arpa', '1.2.arpa,evil', '10.in-addr.arpa\naddress=/x/1.1.1.1']) {
      const res = await request(app).post('/api/dns/zones').send({ name, type: 'reverse' });
      expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    }
  });

  it('still accepts every legitimate reverse zone form', async () => {
    for (const name of ['10.in-addr.arpa', '88.10.in-addr.arpa', '5.88.10.in-addr.arpa']) {
      const res = await request(app).post('/api/dns/zones').send({ name, type: 'reverse' });
      expect([201, 409]).toContain(res.status); // 409 if a prior test already made it
    }
  });

  it('rejects a CNAME alias FQDN outside the zone', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'wrong.example.net',
      type: 'CNAME',
      value: 'target-host.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('rejects a CNAME target that dnsmasq does not know locally', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'missing-target',
      type: 'CNAME',
      value: 'does-not-exist.injtest.example'
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate CNAME alias', async () => {
    const first = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'dupe-cname',
      type: 'CNAME',
      value: 'target-host.injtest.example'
    });
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'dupe-cname',
      type: 'CNAME',
      value: 'target-host.injtest.example'
    });
    expect(second.status).toBe(409);
  });

  it('accepts a normal PTR record (regression guard, sanitizer is not over-strict)', async () => {
    const res = await request(app).post(`/api/dns/zones/${revZone.id}/records`).send({
      name: '7', type: 'PTR', value: 'clean.injtest.example'
    });
    expect(res.status).toBe(201);
  });

  it('refuses manual edits and deletion of generated PTR placeholders', async () => {
    const db = getDb();
    const recordId = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, '8', 'PTR', '10.88.99.8', 'placeholder', 1)
    `).run(revZone.id).lastInsertRowid;

    const edit = await request(app)
      .put(`/api/dns/zones/${revZone.id}/records/${recordId}`)
      .send({ value: 'replacement.injtest.example' });
    const del = await request(app)
      .delete(`/api/dns/zones/${revZone.id}/records/${recordId}`);

    expect(edit.status).toBe(403);
    expect(edit.body.error).toMatch(/assign the hostname through DNS or DHCP/i);
    expect(del.status).toBe(403);
    expect(del.body.error).toMatch(/disable managed reverse DNS/i);
    expect(db.prepare('SELECT value FROM dns_records WHERE id = ?').get(recordId))
      .toEqual({ value: '10.88.99.8' });
  });

  it('accepts a normal TXT record', async () => {
    const res = await request(app).post(`/api/dns/zones/${fwdZone.id}/records`).send({
      name: 'spf', type: 'TXT', value: 'v=spf1 include:_spf.example.com ~all'
    });
    expect(res.status).toBe(201);
  });
});

// -----------------------------------------------------------------------------
// M9, PTR cross-zone conflict
// -----------------------------------------------------------------------------

describe('M9: PTR cross-zone conflict refuses silent overwrite', () => {
  let zoneB;
  let reverseZone;

  beforeAll(async () => {
    // A fresh reverse zone for this test's IP range so prior tests don't interfere.
    const reverse = await request(app).post('/api/dns/zones').send({ name: '77.66.10.in-addr.arpa', type: 'reverse' });
    reverseZone = reverse.body;
    await request(app).post('/api/dns/zones').send({ name: 'alpha.example', type: 'forward' });
    const b = await request(app).post('/api/dns/zones').send({ name: 'beta.example', type: 'forward' });
    zoneB = b.body;

    // Seed a pre-existing PTR pointing at another forward zone. Duplicate A
    // hostnames for one IP are now rejected before PTR sync, so this keeps
    // the PTR hijack guard covered without relying on a second A record.
    const ptr = await request(app).post(`/api/dns/zones/${reverseZone.id}/records`).send({
      name: '50', type: 'PTR', value: 'host1.alpha.example'
    });
    expect(ptr.status).toBe(201);
  });

  it('409 when a second forward zone tries to rewrite the PTR', async () => {
    const res = await request(app).post(`/api/dns/zones/${zoneB.id}/records`).send({
      name: 'host2', type: 'A', value: '10.66.77.50'
    });
    expect(res.status).toBe(409);
    expect(res.body.ptr_conflict).toBeDefined();
  });

  it('force_ptr:true overrides the conflict', async () => {
    const res = await request(app).post(`/api/dns/zones/${zoneB.id}/records`).send({
      name: 'host2', type: 'A', value: '10.66.77.50', force_ptr: true
    });
    expect(res.status).toBe(201);
  });
});

describe('managed PTR projection follows forward-zone state', () => {
  it('demotes to a placeholder on disable and restores the DNS name on re-enable', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO subnets
        (cidr, name, prefix_length, network_address, broadcast_address,
         total_addresses, status, depth, domain_name, has_reverse_dns)
      VALUES ('10.65.44.0/30', 'zone toggle', 30, '10.65.44.0',
              '10.65.44.3', 4, 'allocated', 0, 'toggle.example', 1)
    `).run();
    const reverse = await request(app).post('/api/dns/zones').send({
      name: '44.65.10.in-addr.arpa', type: 'reverse'
    });
    const forward = await request(app).post('/api/dns/zones').send({
      name: 'toggle.example', type: 'forward'
    });
    const created = await request(app)
      .post(`/api/dns/zones/${forward.body.id}/records`)
      .send({ name: 'host', type: 'A', value: '10.65.44.1' });
    expect(created.status).toBe(201);

    const ptr = () => db.prepare(`
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '1'
    `).get(reverse.body.id);
    expect(ptr()).toEqual({ value: 'host.toggle.example', source: 'dns' });

    expect((await request(app).put(`/api/dns/zones/${forward.body.id}`).send({ enabled: false })).status)
      .toBe(200);
    expect(ptr()).toEqual({ value: '10.65.44.1', source: 'placeholder' });

    expect((await request(app).put(`/api/dns/zones/${forward.body.id}`).send({ enabled: true })).status)
      .toBe(200);
    expect(ptr()).toEqual({ value: 'host.toggle.example', source: 'dns' });
  });
});

// -----------------------------------------------------------------------------
// C3, DHCP scope option / domain_name config injection
// -----------------------------------------------------------------------------

describe('C3: DHCP scope config injection', () => {
  let scopeId;

  beforeAll(async () => {
    // Create via the API so all NOT NULL columns get populated by the
    // handler (broadcast_address, etc.), then insert a range + scope.
    const sRes = await request(app).post('/api/subnets').send({
      cidr: '10.44.0.0/24', name: 'dhcp-inj'
    });
    expect(sRes.status).toBe(201);
    const subnetId = sRes.body.id;

    const db = getDb();
    db.prepare("UPDATE subnets SET status = 'allocated', gateway_address = '10.44.0.1' WHERE id = ?")
      .run(subnetId);
    const rtId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
    const rres = db.prepare(`
      INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
      VALUES (?, ?, '10.44.0.10', '10.44.0.100')
    `).run(subnetId, rtId);
    const rangeId = rres.lastInsertRowid;

    const res = await request(app).post('/api/dhcp/scopes').send({
      range_id: rangeId, subnet_id: subnetId, lease_time: '24h'
    });
    expect(res.status).toBe(201);
    scopeId = res.body.id;
  });

  it('rejects scope option value containing LF', async () => {
    const res = await request(app).put(`/api/dhcp/scopes/${scopeId}`).send({
      options: [{ code: 15, value: 'evil.com\ndhcp-option=tag:scope1,6,6.6.6.6\n#' }]
    });
    expect(res.status).toBe(400);
  });

  it('rejects scope domain_name containing LF', async () => {
    const res = await request(app).put(`/api/dhcp/scopes/${scopeId}`).send({
      domain_name: 'ok.example\nshenanigans=1'
    });
    expect(res.status).toBe(400);
  });

  it('rejects scope option value containing =', async () => {
    const res = await request(app).put(`/api/dhcp/scopes/${scopeId}`).send({
      options: [{ code: 15, value: 'k=v' }]
    });
    expect(res.status).toBe(400);
  });

  it('accepts a clean option value', async () => {
    const res = await request(app).put(`/api/dhcp/scopes/${scopeId}`).send({
      options: [{ code: 15, value: 'clean.example' }]
    });
    expect(res.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// H5, /api/subnets/calculate DoS cap
// -----------------------------------------------------------------------------

describe('H5: /api/subnets/calculate child-count cap', () => {
  it('rejects /10 → /30 as over-limit', async () => {
    const res = await request(app).post('/api/subnets/calculate').send({ cidr: '10.0.0.0/10', new_prefix: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum|65536/i);
  });

  it('rejects /8 → /30 as over-limit', async () => {
    const res = await request(app).post('/api/subnets/calculate').send({ cidr: '10.0.0.0/8', new_prefix: 30 });
    expect(res.status).toBe(400);
  });

  it('accepts /24 → /25 (2 children, inside the cap)', async () => {
    const res = await request(app).post('/api/subnets/calculate').send({ cidr: '192.168.200.0/24', new_prefix: 25 });
    expect(res.status).toBe(200);
    expect(res.body.subnets).toHaveLength(2);
  });

  it('rejects non-integer new_prefix', async () => {
    const res = await request(app).post('/api/subnets/calculate').send({ cidr: '10.0.0.0/24', new_prefix: 'abc' });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------------
// H6, JSON body-parse error collapse
// -----------------------------------------------------------------------------

describe('H6: malformed JSON body yields "Invalid JSON body" 400', () => {
  it('responds 400 with generic message', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .set('Content-Type', 'application/json')
      .send('{"unterminated": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON body');
  });
});

// -----------------------------------------------------------------------------
// H7, settings per-key schema
// -----------------------------------------------------------------------------

describe('H7: settings per-key schema rejects shape abuse', () => {
  it('rejects object value for dns_listen_port', async () => {
    const res = await request(app).put('/api/settings/dns_listen_port').send({ value: { a: 1 } });
    expect(res.status).toBe(400);
  });

  it('rejects string value for dns_listen_port', async () => {
    const res = await request(app).put('/api/settings/dns_listen_port').send({ value: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range dns_listen_port', async () => {
    const res = await request(app).put('/api/settings/dns_listen_port').send({ value: 99999 });
    expect(res.status).toBe(400);
  });

  it('accepts a valid integer port', async () => {
    const res = await request(app).put('/api/settings/dns_listen_port').send({ value: 5353 });
    expect(res.status).toBe(200);
  });

  it('rejects unknown key', async () => {
    const res = await request(app).put('/api/settings/totally_fake_key').send({ value: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects non-boolean for geoip_enabled', async () => {
    const res = await request(app).put('/api/settings/geoip_enabled').send({ value: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('accepts UI scan interval values', async () => {
    const res = await request(app).put('/api/settings/default_scan_interval').send({ value: '15m' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('15m');
  });

  it('normalizes off scan interval to empty string', async () => {
    const res = await request(app).put('/api/settings/default_scan_interval').send({ value: 'off' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('');
  });

  it('accepts UI scan enabled values and stores 1/0 for scanner code', async () => {
    const enabled = await request(app).put('/api/settings/default_scan_enabled').send({ value: '1' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.value).toBe('1');

    const disabled = await request(app).put('/api/settings/default_scan_enabled').send({ value: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.value).toBe('0');
  });

  it('rejects the obsolete configurable offline metadata retention period', async () => {
    const res = await request(app).put('/api/settings/offline_metadata_retention_days').send({ value: '14' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be modified/);
  });
});

// -----------------------------------------------------------------------------
// H3/H4, SSRF guard rejects loopback / link-local / RFC1918
// -----------------------------------------------------------------------------

describe('H3/H4: outbound URL guard rejects private IPs', () => {
  it('rejects Pi-hole probe with http://127.0.0.1', async () => {
    const res = await request(app).post('/api/pihole/probe').send({ url: 'http://127.0.0.1:8080' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked range|127\.0\.0\.0/);
  });

  it('rejects Pi-hole fetch with 169.254.169.254 (AWS/GCP metadata)', async () => {
    const res = await request(app).post('/api/pihole/fetch').send({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBe(400);
  });

  it('rejects Pi-hole probe with an RFC1918 address', async () => {
    const res = await request(app).post('/api/pihole/probe').send({ url: 'http://10.0.0.1' });
    expect(res.status).toBe(400);
  });

  it('rejects blocklist source_url pointing at loopback', async () => {
    // ensureCategoryRows runs lazily on first categories GET; trigger it.
    await request(app).get('/api/blocklists/categories');
    const res = await request(app)
      .put('/api/blocklists/categories/ads/url')
      .send({ source_url: 'http://127.0.0.1:8000/steal' });
    expect(res.status).toBe(400);
  });

  it('rejects non-http scheme', async () => {
    const res = await request(app).post('/api/pihole/probe').send({ url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------------
// M6, JSON 404 fallback
// -----------------------------------------------------------------------------

describe('M6: JSON 404 fallback on unknown /api path', () => {
  it('GET /api/nothing returns JSON 404', async () => {
    const res = await request(app).get('/api/nothing');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('Not found');
  });
});

// -----------------------------------------------------------------------------
// M8, Display-string validator rejects angle brackets + control chars
// -----------------------------------------------------------------------------

describe('M8: display-string validator on subnet name/description', () => {
  it('rejects subnet name containing <', async () => {
    const res = await request(app).post('/api/subnets').send({
      cidr: '10.55.0.0/24', name: '<script>alert(1)</script>'
    });
    expect(res.status).toBe(400);
  });

  it('rejects subnet description containing >', async () => {
    const res = await request(app).post('/api/subnets').send({
      cidr: '10.55.1.0/24', name: 'ok', description: 'bad > text'
    });
    expect(res.status).toBe(400);
  });

  it('accepts a clean name', async () => {
    const res = await request(app).post('/api/subnets').send({
      cidr: '10.55.2.0/24', name: 'Perfectly normal name 123 -_. '
    });
    expect(res.status).toBe(201);
  });
});

// -----------------------------------------------------------------------------
// V1, Backend-authoritative validation for route-specific operational inputs
// -----------------------------------------------------------------------------

describe('V1: validation gaps from route-specific write paths', () => {
  it('rejects Pi-hole import records with invalid DNS data before persistence', async () => {
    const zoneRes = await request(app).post('/api/dns/zones').send({
      name: 'pihole-validation.test',
      type: 'forward'
    });
    expect(zoneRes.status).toBe(201);

    const bad = await request(app).post('/api/pihole/import').send({
      zoneId: zoneRes.body.id,
      hosts: [{ hostname: 'bad\nhost.pihole-validation.test', ip: '10.0.0.10' }],
      cnames: [],
      dhcpHosts: []
    });

    expect(bad.status).toBe(400);
    const rows = getDb().prepare('SELECT * FROM dns_records WHERE zone_id = ?').all(zoneRes.body.id);
    expect(rows).toHaveLength(0);
  });

  it('rejects SOA values that could escape generated dnsmasq comments', async () => {
    const res = await request(app).put('/api/dns/soa-defaults').send({
      soa_primary_ns: 'ns1.safe.test\nserver=/bad/1.2.3.4'
    });
    expect(res.status).toBe(400);
  });

  it('rejects per-IP writes outside the owning subnet', async () => {
    const subnet = await request(app).post('/api/subnets').send({
      cidr: '10.56.0.0/24',
      name: 'ip-write-validation'
    });
    expect(subnet.status).toBe(201);

    const res = await request(app)
      .put(`/api/subnets/${subnet.body.id}/ips/10.57.0.8/allocation`)
      .send({ allocation_state: 'reserved', note: 'outside' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/within the subnet/i);
  });

  it('rejects malformed global DHCP option defaults', async () => {
    const res = await request(app).put('/api/dhcp/options/defaults').send({
      options: [{ code: 51, value: 'not-a-lease-time' }],
      enabledDefaults: [51]
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lease time/i);
  });

  it('uses the runtime GeoIP mode enum in generic settings writes', async () => {
    const res = await request(app).put('/api/settings/geoip_mode').send({ value: 'block-country' });
    expect(res.status).toBe(400);
  });
});

// -----------------------------------------------------------------------------
// M1 / M2, Login + change-password rate limiters
//
// These tests HAVE to run last in the file because they exhaust the
// loginLimiter's 15-minute window (which doesn't reset between tests in the
// same process). Placing them at the end keeps earlier tests unaffected.
// -----------------------------------------------------------------------------

describe('M2: login rate limiter trips on too many bad attempts', () => {
  // Uses a FRESH supertest agent so it doesn't share an IP bucket with
  // earlier tests... which it actually does since supertest binds to the
  // same ephemeral loopback. We're checking the trip itself, not the cap.
  it('returns 429 after enough rapid bad-password attempts', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      const res = await request(noAuthApp)
        .post('/api/auth/login')
        .send({ username: 'sectest', password: 'wrong' });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  }, 30_000);
});

describe('M1: change-password rate limiter caps at 10/15min per IP', () => {
  it('returns 429 after 10+ bad-current-password attempts', async () => {
    const cpApp = createTestApp(authRouter, '/api/auth');
    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(cpApp)
        .post('/api/auth/change-password')
        .send({ current_password: 'definitely-wrong', new_password: 'NewLongerPass456' });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  }, 30_000);
});

// -----------------------------------------------------------------------------
// CodeQL #5, blocklist search: array-typed query param must not crash
// -----------------------------------------------------------------------------
describe('blocklist search query type confusion', () => {
  it('returns an empty result, not a 500, when q is supplied twice (array)', async () => {
    const res = await request(app).get('/api/blocklists/search?q=aaa&q=bbb');
    expect(res.status).toBe(200);
    // `total` was dropped when the endpoint stopped running a COUNT(DISTINCT)
    // full scan on every search; the guard reports `hasMore` instead. The
    // property this test exists for is unchanged: an array-typed q is refused
    // by the typeof check rather than reaching SQL.
    expect(res.body).toMatchObject({ items: [], hasMore: false });
    expect(res.body.total, 'total is gone, not renamed').toBeUndefined();
  });

  it('still serves normal string queries', async () => {
    const res = await request(app).get('/api/blocklists/search?q=ads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
