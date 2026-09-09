import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import {
  enqueueGeneration,
  findGeneration,
  markApplied,
  markApplying,
  markFailed
} from '../../../src/models/configuration-generation.js';

let db;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('durable configuration generations', () => {
  it('tracks pending, applied, trailing, and failed generations', () => {
    const first = enqueueGeneration(db, 'regenerate_dhcp');
    expect(first).toMatchObject({ desired_generation: 1, applied_generation: 0, status: 'pending' });
    const applying = markApplying(db, 'regenerate_dhcp');
    expect(applying.status).toBe('applying');
    enqueueGeneration(db, 'regenerate_dhcp');
    markApplied(db, 'regenerate_dhcp', applying.desired_generation);
    expect(findGeneration(db, 'regenerate_dhcp')).toMatchObject({
      desired_generation: 2, applied_generation: 1, status: 'pending'
    });
    markFailed(db, 'regenerate_dhcp', 'dnsmasq rejected configuration');
    expect(findGeneration(db, 'regenerate_dhcp')).toMatchObject({
      status: 'failed', last_error: 'dnsmasq rejected configuration'
    });
  });
});
