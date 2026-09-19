/**
 * The ?dhcp= parameter on POST /api/operations/restore: whether the appliance
 * serves DHCP after the restart. restoreBackup itself swaps DATA_DIR and exits
 * the process, so it is mocked; what is under test is the parameter contract,
 * the audit trail and the value handed to the restore.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

const { restoreBackup, inspectBackup } = vi.hoisted(() => ({
  restoreBackup: vi.fn(),
  inspectBackup: vi.fn(),
}));
vi.mock('../../../src/utils/backup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  restoreBackup,
  inspectBackup,
}));

const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  const { default: operationsRouter } = await import('../../../src/routes/operations.js');
  app = createMultiRouterApp([{ prefix: '/api/operations', router: operationsRouter }]);
  inspectBackup.mockReturnValue({ compatible: true, manifest: { version: '0.5.0' } });
  restoreBackup.mockImplementation((_path, opts) => ({
    ok: true,
    message: 'mocked',
    dhcp_after_restore: opts.dhcpAfterRestore,
  }));
});

afterAll(() => cleanupTestDb(tmpDir));

const send = (query) =>
  request(app)
    .post(`/api/operations/restore${query}`)
    .set('Content-Type', 'application/gzip')
    .send(Buffer.from('not really a tarball'));

const lastAudit = () =>
  db.prepare("SELECT details FROM audit_log WHERE action = 'restore' ORDER BY id DESC").get();

describe('POST /api/operations/restore ?dhcp=', () => {
  it('rejects anything but enabled or disabled', async () => {
    const res = await send('?dhcp=maybe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('dhcp must be "enabled" or "disabled"');
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it('hands the restoring user to the restore so the restored database keeps a record', async () => {
    restoreBackup.mockClear();
    const res = await send('?dhcp=disabled');
    expect(res.status).toBe(200);
    expect(restoreBackup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ restoredBy: { username: 'testadmin' } }),
    );
  });

  it('passes the choice to the restore and records it in the audit log', async () => {
    const off = await send('?dhcp=disabled');
    expect(off.status).toBe(200);
    expect(off.body.dhcp_after_restore).toBe(false);
    expect(restoreBackup).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ dhcpAfterRestore: false }),
    );
    expect(JSON.parse(lastAudit().details)).toMatchObject({ dhcp_after_restore: false });

    const on = await send('?dhcp=enabled');
    expect(on.status).toBe(200);
    expect(restoreBackup).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ dhcpAfterRestore: true }),
    );
    expect(JSON.parse(lastAudit().details)).toMatchObject({ dhcp_after_restore: true });
  });

  it("keeps the backup's own setting when the parameter is omitted", async () => {
    const res = await send('');
    expect(res.status).toBe(200);
    expect(restoreBackup).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ dhcpAfterRestore: null }),
    );
    expect(JSON.parse(lastAudit().details)).toMatchObject({ dhcp_after_restore: null });
  });

  it('ignores the parameter on an inspect-only call', async () => {
    restoreBackup.mockClear();
    const res = await send('?inspect=1&dhcp=maybe');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ compatible: true });
    expect(restoreBackup).not.toHaveBeenCalled();
  });
});
