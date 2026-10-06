import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';

// No handlers: setupTestDb registers whatever backend-apply exports, so this
// leaves every hook known but unwired, as index.js would be if it forgot.
vi.mock('../../../src/services/backend-apply.js', () => ({ HOOK_HANDLERS: {} }));

const { queueRegen, registerHookHandlers } = await import('../../../src/utils/after-commit.js');
const { findGeneration } = await import('../../../src/models/configuration-generation.js');

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});

afterAll(() => cleanupTestDb(tmpDir));

describe('after-commit hook registration', () => {
  it('fails a known hook nothing was registered for, keeping it pending', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueRegen('regenerate_dns');
    await vi.waitFor(() => {
      expect(findGeneration(db, 'regenerate_dns')).toMatchObject({
        status: 'failed',
        last_error: 'No handler registered for regenerate_dns',
      });
    });
    const row = findGeneration(db, 'regenerate_dns');
    expect(row.desired_generation).toBeGreaterThan(row.applied_generation);
    error.mockRestore();
  });

  it('refuses a handler for a hook name it does not know, or one that is not a function', () => {
    expect(() => registerHookHandlers({ regenerate_ntp: () => {} })).toThrow(
      'Unknown afterCommit hook: regenerate_ntp',
    );
    expect(() => registerHookHandlers({ regenerate_dns: 'applyDns' })).toThrow(
      'afterCommit hook regenerate_dns needs a function',
    );
    expect(() => queueRegen('regenerate_ntp')).toThrow('Unknown afterCommit hook: regenerate_ntp');
  });
});
