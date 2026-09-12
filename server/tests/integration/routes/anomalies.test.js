import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// The evidence endpoint reads DuckDB, which no test fixture stands up. Stub
// only the two query helpers and record their arguments: which IP and which
// window the route asks for is the behavior under test, not the SQL.
const { evidenceCalls, summaryCalls, evidenceRows } = vi.hoisted(() => ({
  evidenceCalls: [],
  summaryCalls: [],
  evidenceRows: [],
}));

vi.mock('../../../src/db/duckdb.js', async (importOriginal) => ({
  ...await importOriginal(),
  queryClientWindowEvidence: (...args) => {
    evidenceCalls.push(args);
    return Promise.resolve(evidenceRows.slice(0, args[3]));
  },
  queryClientWindowSummary: (...args) => {
    summaryCalls.push(args);
    return Promise.resolve({
      total_queries: evidenceRows.reduce((sum, row) => sum + row.count, 0),
      distinct_domains: evidenceRows.length,
      nxdomain_count: evidenceRows.filter(row => row.response_code === 'NXDOMAIN').length,
      blocked_count: 0,
    });
  },
}));

const { default: anomalyRouter } = await import('../../../src/routes/anomalies.js');
const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;

function insertAnomaly(ip, severity = 'medium') {
  return db.prepare(`
    INSERT INTO anomaly_scores
      (client_ip, window_start, window_end, anomaly_score, is_anomaly, severity)
    VALUES (?, datetime('now', '-5 minutes'), datetime('now'), 0.95, 1, ?)
  `).run(ip, severity).lastInsertRowid;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createTestApp(anomalyRouter, '/api/anomalies');
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM anomaly_scores').run();
  db.prepare('DELETE FROM anomaly_models').run();
  db.prepare('DELETE FROM anomaly_whitelist').run();
  db.prepare('DELETE FROM dhcp_leases').run();
  db.prepare("DELETE FROM settings WHERE key = 'anomaly_acknowledged_score_id'").run();
});

function setLease(ip, mac) {
  db.prepare(
    `INSERT INTO dhcp_leases (ip_address, mac_address, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`
  ).run(ip, mac);
}

function insertScore(ip, { daysAgo = 0, isAnomaly = 1, resolved = 0, severity = 'medium' } = {}) {
  return db.prepare(`
    INSERT INTO anomaly_scores
      (client_ip, window_start, window_end, anomaly_score, is_anomaly, severity, resolved)
    VALUES (?, datetime('now', '-' || ? || ' days'), datetime('now', '-' || ? || ' days'), 0.9, ?, ?, ?)
  `).run(ip, daysAgo, daysAgo, isAnomaly, severity, resolved).lastInsertRowid;
}

describe('anomaly notification counter', () => {
  it('counts only active anomalies newer than the acknowledged score id', async () => {
    insertAnomaly('10.0.0.10', 'high');
    insertAnomaly('10.0.0.11', 'medium');

    const before = await request(app).get('/api/anomalies/summary');
    expect(before.status).toBe(200);
    expect(before.body.total_active).toBe(2);
    expect(before.body.unacknowledged_active).toBe(2);

    const ack = await request(app).post('/api/anomalies/acknowledge');
    expect(ack.status).toBe(200);
    expect(ack.body.unacknowledged_active).toBe(0);

    const afterAck = await request(app).get('/api/anomalies/summary');
    expect(afterAck.body.total_active).toBe(2);
    expect(afterAck.body.unacknowledged_active).toBe(0);

    insertAnomaly('10.0.0.12', 'low');

    const afterNew = await request(app).get('/api/anomalies/summary');
    expect(afterNew.body.total_active).toBe(3);
    expect(afterNew.body.unacknowledged_active).toBe(1);
  });
});

describe('GET /api/anomalies/events', () => {
  it('includes resolved events, unlike /active', async () => {
    insertScore('10.0.0.20', { resolved: 1 });
    insertScore('10.0.0.21', { resolved: 0 });

    const active = await request(app).get('/api/anomalies/active');
    expect(active.body).toHaveLength(1);

    const events = await request(app).get('/api/anomalies/events');
    expect(events.status).toBe(200);
    expect(events.body.events.map(e => e.client_ip).sort()).toEqual(['10.0.0.20', '10.0.0.21']);
  });

  it('excludes non-anomalous windows', async () => {
    insertScore('10.0.0.22', { isAnomaly: 0 });
    insertScore('10.0.0.23', { isAnomaly: 1 });

    const events = await request(app).get('/api/anomalies/events');
    expect(events.body.events.map(e => e.client_ip)).toEqual(['10.0.0.23']);
  });

  it('excludes events older than the requested window', async () => {
    insertScore('10.0.0.24', { daysAgo: 20 });
    insertScore('10.0.0.25', { daysAgo: 1 });

    const defaultWindow = await request(app).get('/api/anomalies/events');
    expect(defaultWindow.body.events.map(e => e.client_ip)).toEqual(['10.0.0.25']);

    const wideWindow = await request(app).get('/api/anomalies/events?days=30');
    expect(wideWindow.body.events.map(e => e.client_ip).sort()).toEqual(['10.0.0.24', '10.0.0.25']);
  });

  it('lists clients still in the learning phase, not active ones', async () => {
    db.prepare(`INSERT INTO anomaly_models (identity, client_ip, status, training_rows) VALUES (?, ?, 'learning', 6)`).run('10.0.0.30', '10.0.0.30');
    db.prepare(`INSERT INTO anomaly_models (identity, client_ip, status, training_rows) VALUES (?, ?, 'active', 500)`).run('10.0.0.31', '10.0.0.31');

    const events = await request(app).get('/api/anomalies/events');
    expect(events.body.learning.map(l => l.client_ip)).toEqual(['10.0.0.30']);
  });
});

describe('identity-keyed client routes', () => {
  it('GET /client/:identity looks up by identity, not client_ip', async () => {
    setLease('10.0.0.40', 'aa:bb:cc:dd:ee:40');
    db.prepare(`
      INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
      VALUES ('10.0.0.40', 'aa:bb:cc:dd:ee:40', datetime('now', '-1 hour'), datetime('now'), 0.3, 0)
    `).run();

    const byIdentity = await request(app).get('/api/anomalies/client/aa:bb:cc:dd:ee:40');
    expect(byIdentity.status).toBe(200);
    expect(byIdentity.body).toHaveLength(1);
    expect(byIdentity.body[0].client_ip).toBe('10.0.0.40');

    // The raw IP is no longer the lookup key once a MAC identity exists.
    const byIp = await request(app).get('/api/anomalies/client/10.0.0.40');
    expect(byIp.body).toHaveLength(0);
  });

  it('GET /client/:identity falls back to the IP itself when no MAC is known', async () => {
    db.prepare(`
      INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
      VALUES ('10.0.0.41', '10.0.0.41', datetime('now', '-1 hour'), datetime('now'), 0.3, 0)
    `).run();

    const res = await request(app).get('/api/anomalies/client/10.0.0.41');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /client/:identity rejects a value that is neither a MAC nor an IPv4', async () => {
    const res = await request(app).get('/api/anomalies/client/not-a-valid-identity');
    expect(res.status).toBe(400);
  });

  it('GET /client/:identity/model looks up model metadata by identity', async () => {
    db.prepare(`
      INSERT INTO anomaly_models (identity, client_ip, status, training_rows, trained_at)
      VALUES ('aa:bb:cc:dd:ee:42', '10.0.0.42', 'active', 200, datetime('now'))
    `).run();

    const res = await request(app).get('/api/anomalies/client/aa:bb:cc:dd:ee:42/model');
    expect(res.status).toBe(200);
    expect(res.body.training_rows).toBe(200);
    expect(res.body.client_ip).toBe('10.0.0.42');
  });
});

describe('POST /api/anomalies/whitelist', () => {
  it('resolves the current MAC and whitelists by identity', async () => {
    setLease('10.0.0.50', 'aa:bb:cc:dd:ee:50');
    const res = await request(app).post('/api/anomalies/whitelist').send({ client_ip: '10.0.0.50' });
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT identity, client_ip FROM anomaly_whitelist WHERE id = ?').get(res.body.id);
    expect(row).toMatchObject({ identity: 'aa:bb:cc:dd:ee:50', client_ip: '10.0.0.50' });
  });

  it('stays whitelisted under a renewed IP for the same MAC', async () => {
    setLease('10.0.0.51', 'aa:bb:cc:dd:ee:51');
    const first = await request(app).post('/api/anomalies/whitelist').send({ client_ip: '10.0.0.51' });
    expect(first.status).toBe(201);

    // Device renews to a new IP; DHCP now maps the new IP to the same MAC.
    db.prepare('DELETE FROM dhcp_leases WHERE ip_address = ?').run('10.0.0.51');
    setLease('10.0.0.52', 'aa:bb:cc:dd:ee:51');

    const second = await request(app).post('/api/anomalies/whitelist').send({ client_ip: '10.0.0.52' });
    expect(second.status).toBe(409);
  });

  it('purges scores and model rows for every IP the identity has ever used', async () => {
    setLease('10.0.0.53', 'aa:bb:cc:dd:ee:53');
    db.prepare(`
      INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
      VALUES ('10.0.0.53', 'aa:bb:cc:dd:ee:53', datetime('now'), datetime('now'), 0.9, 1)
    `).run();
    db.prepare(`
      INSERT INTO anomaly_models (identity, client_ip, status, training_rows) VALUES ('aa:bb:cc:dd:ee:53', '10.0.0.53', 'active', 100)
    `).run();

    await request(app).post('/api/anomalies/whitelist').send({ client_ip: '10.0.0.53' });

    expect(db.prepare('SELECT COUNT(*) c FROM anomaly_scores WHERE identity = ?').get('aa:bb:cc:dd:ee:53').c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM anomaly_models WHERE identity = ?').get('aa:bb:cc:dd:ee:53').c).toBe(0);
  });
});

describe('anomaly evidence endpoint', () => {
  function insertScoredWindow({ identity, clientIp, start, end, isAnomaly = 1 }) {
    db.prepare(`
      INSERT INTO anomaly_scores
        (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly, severity)
      VALUES (?, ?, ?, ?, -0.62, ?, 'high')
    `).run(clientIp, identity, start, end, isAnomaly);
  }

  beforeEach(() => {
    evidenceCalls.length = 0;
    summaryCalls.length = 0;
    evidenceRows.length = 0;
  });

  it('rejects an identity that is neither a MAC nor an IPv4 address', async () => {
    const res = await request(app).get('/api/anomalies/client/not-an-identity/evidence');
    expect(res.status).toBe(400);
  });

  it('404s when the identity has no flagged window', async () => {
    const res = await request(app).get('/api/anomalies/client/10.0.0.80/evidence');
    expect(res.status).toBe(404);
  });

  it('defaults to the most recent flagged window', async () => {
    insertScoredWindow({ identity: '10.0.0.81', clientIp: '10.0.0.81', start: '2026-09-10 01:00:00', end: '2026-09-10 02:00:00' });
    insertScoredWindow({ identity: '10.0.0.81', clientIp: '10.0.0.81', start: '2026-09-10 05:00:00', end: '2026-09-10 06:00:00' });

    const res = await request(app).get('/api/anomalies/client/10.0.0.81/evidence');
    expect(res.status).toBe(200);
    expect(res.body.window_start).toBe('2026-09-10 05:00:00');
    expect(evidenceCalls[0].slice(0, 3)).toEqual(['10.0.0.81', '2026-09-10 05:00:00', '2026-09-10 06:00:00']);
  });

  it('honours an explicit window_start, including a window that was not flagged', async () => {
    insertScoredWindow({ identity: '10.0.0.82', clientIp: '10.0.0.82', start: '2026-09-10 03:00:00', end: '2026-09-10 04:00:00', isAnomaly: 0 });

    const res = await request(app)
      .get('/api/anomalies/client/10.0.0.82/evidence')
      .query({ window_start: '2026-09-10 03:00:00' });

    expect(res.status).toBe(200);
    expect(res.body.is_anomaly).toBe(0);
    expect(evidenceCalls[0][1]).toBe('2026-09-10 03:00:00');
  });

  // The bug this pins: an identity is a MAC, dns_queries is keyed by IP, and
  // dhcp_leases only holds the CURRENT lease. Resolving the MAC's lease at
  // request time would return whatever holds that address today.
  it('queries the IP recorded on the score row, not the MAC current lease', async () => {
    setLease('10.0.0.99', 'aa:bb:cc:dd:ee:90');
    insertScoredWindow({
      identity: 'aa:bb:cc:dd:ee:90', clientIp: '10.0.0.90',
      start: '2026-09-10 07:00:00', end: '2026-09-10 08:00:00',
    });

    const res = await request(app).get('/api/anomalies/client/aa:bb:cc:dd:ee:90/evidence');

    expect(res.status).toBe(200);
    expect(res.body.client_ip).toBe('10.0.0.90');
    expect(evidenceCalls[0][0]).toBe('10.0.0.90');
    expect(summaryCalls[0][0]).toBe('10.0.0.90');
  });

  it('separates a pruned window from a client that was simply quiet', async () => {
    insertScoredWindow({
      identity: '10.0.0.83', clientIp: '10.0.0.83',
      start: "2026-09-10 09:00:00", end: "2026-09-10 10:00:00",
    });
    const fresh = await request(app).get('/api/anomalies/client/10.0.0.83/evidence');
    expect(fresh.body.evidence_available).toBe(false);

    db.prepare('DELETE FROM anomaly_scores').run();
    db.prepare(`
      INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
      VALUES ('10.0.0.84', '10.0.0.84', datetime('now', '-20 days'), datetime('now', '-20 days', '+1 hour'), -0.62, 1)
    `).run();

    const old = await request(app).get('/api/anomalies/client/10.0.0.84/evidence');
    expect(old.status).toBe(200);
    expect(old.body.window_within_retention).toBe(false);
    expect(old.body.retention_days).toBe(7);
  });

  // The scoring sidecar writes Python's datetime.isoformat(), so a real
  // window_start looks like '2026-09-10T13:00:00+00:00'. DuckDB's TIMESTAMP
  // cast will not take the offset suffix, so the route has to canonicalize
  // before it queries. Tested against both shapes because rows written
  // through SQLite's own datetime() use the space-separated form.
  it('canonicalizes sidecar ISO window bounds before querying DuckDB', async () => {
    insertScoredWindow({
      identity: '10.0.0.86', clientIp: '10.0.0.86',
      start: '2026-09-10T13:00:00+00:00', end: '2026-09-10T14:00:00+00:00',
    });

    const res = await request(app).get('/api/anomalies/client/10.0.0.86/evidence');

    expect(res.status).toBe(200);
    expect(evidenceCalls[0][1]).toBe('2026-09-10 13:00:00');
    expect(evidenceCalls[0][2]).toBe('2026-09-10 14:00:00');
    // The response still reports the window as it is stored, so the caller can
    // pass it straight back as ?window_start.
    expect(res.body.window_start).toBe('2026-09-10T13:00:00+00:00');
  });

  it('treats a millisecond Z timestamp as UTC for the retention check', async () => {
    insertScoredWindow({
      identity: '10.0.0.87', clientIp: '10.0.0.87',
      start: '2026-09-10T15:00:00.000Z', end: '2026-09-10T16:00:00.000Z',
    });

    const res = await request(app).get('/api/anomalies/client/10.0.0.87/evidence');

    expect(res.status).toBe(200);
    expect(evidenceCalls[0][1]).toBe('2026-09-10 15:00:00');
    expect(typeof res.body.window_within_retention).toBe('boolean');
  });

  it('reports truncation when the grouped rows hit the limit', async () => {
    insertScoredWindow({ identity: '10.0.0.85', clientIp: '10.0.0.85', start: '2026-09-10 11:00:00', end: '2026-09-10 12:00:00' });
    evidenceRows.push(
      { domain: 'a.example.com', query_type: 'A', response_code: 'NXDOMAIN', action: 'allowed', count: 9 },
      { domain: 'b.example.com', query_type: 'A', response_code: 'NOERROR', action: 'allowed', count: 4 },
    );

    const res = await request(app).get('/api/anomalies/client/10.0.0.85/evidence').query({ limit: 2 });
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.truncated).toBe(true);
    expect(res.body.evidence_available).toBe(true);
    expect(evidenceCalls[0][3]).toBe(2);
  });
});
