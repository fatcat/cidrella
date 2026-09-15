import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

const { default: request } = await import('supertest');
const { default: auditRouter } = await import('../../../src/routes/audit.js');

let app;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  const insert = setup.db.prepare(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(1, 'update', 'subnet', 10, '{}');
  insert.run(1, 'update', 'subnet', 11, '{}');
  insert.run(1, 'update', 'dns_zone', 10, '{}');
  app = createTestApp(auditRouter, '/api/audit');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('audit exact-entity scoping', () => {
  it('filters by entity type and ID before pagination', async () => {
    const response = await request(app)
      .get('/api/audit')
      .query({ entity_type: 'subnet', entity_id: 10, page: 1, limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ entity_type: 'subnet', entity_id: 10 });
  });

  it.each([
    [{ entity_id: 10 }, 'requires exactly one entity_type'],
    [{ entity_type: 'subnet,dns_zone', entity_id: 10 }, 'requires exactly one entity_type'],
    [{ entity_type: 'subnet', entity_id: 'not-an-id' }, 'Invalid entity_id'],
  ])('rejects ambiguous or malformed exact-entity filters', async (query, message) => {
    const response = await request(app).get('/api/audit').query(query);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(message);
  });
});
