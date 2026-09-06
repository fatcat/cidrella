import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

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
  db.prepare("DELETE FROM settings WHERE key = 'anomaly_acknowledged_score_id'").run();
});

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
    db.prepare(`INSERT INTO anomaly_models (client_ip, status, training_rows) VALUES (?, 'learning', 6)`).run('10.0.0.30');
    db.prepare(`INSERT INTO anomaly_models (client_ip, status, training_rows) VALUES (?, 'active', 500)`).run('10.0.0.31');

    const events = await request(app).get('/api/anomalies/events');
    expect(events.body.learning.map(l => l.client_ip)).toEqual(['10.0.0.30']);
  });
});
