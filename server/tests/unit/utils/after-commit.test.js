import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';

vi.mock('../../../src/services/backend-apply.js', async () =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply({}),
);

const { applyDhcp, applyDns } = await import('../../../src/services/backend-apply.js');
const { enqueueGeneration, findGeneration } =
  await import('../../../src/models/configuration-generation.js');
const { holdHooks, queueRegen, resumePendingRegeneration } =
  await import('../../../src/utils/after-commit.js');

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
});

beforeEach(() => {
  applyDhcp.mockReset();
  applyDns.mockReset();
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

  // PowerDNS writes zones over HTTP, so its hook returns a Promise.
  it('waits for a hook that returns a Promise, and runs it again for work queued meanwhile', async () => {
    let finishFirst;
    applyDns
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockImplementationOnce(() => Promise.resolve());
    queueRegen('regenerate_dns');
    await vi.waitFor(() => expect(applyDns).toHaveBeenCalledTimes(1));
    expect(findGeneration(db, 'regenerate_dns').status).toBe('applying');
    queueRegen('regenerate_dns');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Not twice at once: the second waits for the first to settle.
    expect(applyDns).toHaveBeenCalledTimes(1);
    finishFirst();
    await vi.waitFor(() => {
      expect(applyDns).toHaveBeenCalledTimes(2);
      expect(findGeneration(db, 'regenerate_dns')).toMatchObject({
        desired_generation: 2,
        applied_generation: 2,
        status: 'applied',
      });
    });
  });

  it('records a rejected Promise as a failure', async () => {
    applyDns.mockImplementationOnce(() =>
      Promise.reject(new Error('PowerDNS refused zone changes')),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueRegen('regenerate_dns');
    await vi.waitFor(() => {
      expect(findGeneration(db, 'regenerate_dns')).toMatchObject({
        status: 'failed',
        last_error: 'PowerDNS refused zone changes',
      });
    });
    error.mockRestore();
  });

  // A stack switch holds the hooks: none runs against a backend being swapped.
  it('holdHooks waits for a running hook, defers new ones, and runs them on release', async () => {
    let finishRunning;
    applyDns
      .mockImplementationOnce(() => new Promise((resolve) => (finishRunning = resolve)))
      .mockImplementation(() => Promise.resolve());
    queueRegen('regenerate_dns');
    await vi.waitFor(() => expect(applyDns).toHaveBeenCalledTimes(1));
    let held = false;
    const holding = holdHooks({ intervalMs: 5 }).then((release) => {
      held = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toBe(false);
    finishRunning();
    const release = await holding;
    queueRegen('regenerate_dhcp');
    queueRegen('regenerate_dns');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applyDhcp).not.toHaveBeenCalled();
    expect(applyDns).toHaveBeenCalledTimes(1);
    release();
    release(); // a second release is a no-op
    await vi.waitFor(() => {
      expect(applyDhcp).toHaveBeenCalledTimes(1);
      expect(applyDns).toHaveBeenCalledTimes(2);
      expect(findGeneration(db, 'regenerate_dhcp').status).toBe('applied');
    });
  });
});
