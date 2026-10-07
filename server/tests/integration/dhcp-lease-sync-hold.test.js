/**
 * The lease sync stands still while a DHCP server switch holds it (the new
 * server has no leases until they are handed over), and catches up once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../src/backends/index.js', async () =>
  (await import('../helpers/fake-backends.js')).fakeBackendsModule(),
);

const { setupTestDb, cleanupTestDb } = await import('../helpers/test-db.js');
const { backend } = await import('../../src/backends/index.js');
const { holdLeaseSync, startLeaseSync } = await import('../../src/services/dhcp-lease-sync.js');

let db;
let tmpDir;
let stop;
const reads = vi.fn();
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const read = backend.dhcp.readLeases;
  backend.dhcp.readLeases = (...args) => {
    reads();
    return read(...args);
  };
});
afterAll(() => {
  stop?.();
  cleanupTestDb(tmpDir);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('holdLeaseSync', () => {
  it('syncs nothing while held, then once for everything seen meanwhile', async () => {
    stop = startLeaseSync(db);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    const release = await holdLeaseSync();
    backend.seedLeases([]);
    backend.seedLeases([]);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    release();
    release();
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('waits for a sync under way before holding', async () => {
    let finish;
    backend.dhcp.readLeases = () => {
      reads();
      return new Promise((resolve) => {
        finish = () => resolve({ leases: [] });
      });
    };
    backend.seedLeases([]);
    let held = false;
    const holding = holdLeaseSync().then((release) => {
      held = true;
      return release;
    });
    await settle();
    expect(held).toBe(false);
    finish();
    (await holding)();
    expect(held).toBe(true);
  });

  it('catches up on a change seen during a sync that a hold then stopped', async () => {
    let finish;
    backend.dhcp.readLeases = () => {
      reads();
      return new Promise((resolve) => {
        finish = () => resolve({ leases: [] });
      });
    };
    backend.seedLeases([]);
    await settle();
    // A second change while that sync runs, then a hold before it loops.
    backend.seedLeases([]);
    const holding = holdLeaseSync();
    const before = reads.mock.calls.length;
    finish();
    const release = await holding;
    expect(reads).toHaveBeenCalledTimes(before);
    release();
    await settle();
    expect(reads).toHaveBeenCalledTimes(before + 1);
    finish();
  });
});
