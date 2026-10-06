import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/services/backend-apply.js', async () =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply({}),
);

const { applyDhcp } = await import('../../../src/services/backend-apply.js');
const { enqueueGeneration, findGeneration } =
  await import('../../../src/models/configuration-generation.js');
const { resumePendingRegeneration } = await import('../../../src/utils/after-commit.js');

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});

beforeEach(() => {
  applyDhcp.mockReset();
  db.prepare(
    `
    UPDATE configuration_generations
    SET desired_generation = 0, applied_generation = 0, status = 'applied', last_error = NULL
  `,
  ).run();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('durable after-commit recovery', () => {
  it('applies pending work discovered after restart', async () => {
    enqueueGeneration(db, 'regenerate_dhcp');
    resumePendingRegeneration();
    await vi.waitFor(() => {
      expect(findGeneration(db, 'regenerate_dhcp')).toMatchObject({
        desired_generation: 1,
        applied_generation: 1,
        status: 'applied',
      });
    });
    expect(applyDhcp).toHaveBeenCalledTimes(1);
  });

  it('retains failure details and succeeds on a later restart retry', async () => {
    applyDhcp.mockImplementationOnce(() => {
      throw new Error('injected dnsmasq validation failure');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueGeneration(db, 'regenerate_dhcp');
    resumePendingRegeneration();
    await vi.waitFor(() => {
      expect(findGeneration(db, 'regenerate_dhcp')).toMatchObject({
        status: 'failed',
        last_error: 'injected dnsmasq validation failure',
      });
    });
    resumePendingRegeneration();
    await vi.waitFor(() => {
      expect(findGeneration(db, 'regenerate_dhcp')).toMatchObject({
        desired_generation: 1,
        applied_generation: 1,
        status: 'applied',
        last_error: null,
      });
    });
    error.mockRestore();
    expect(applyDhcp).toHaveBeenCalledTimes(2);
  });
});
