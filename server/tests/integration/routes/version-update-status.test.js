// GET /api/version/update-status and the record update.sh leaves behind. The
// update panel hides Install while the status reads `completed`, so a record
// from an earlier update must not read as current once another version runs.
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: request } = await import('supertest');

let tmpDir;
let app;
let APP_VERSION;
const statusFile = () => path.join(tmpDir, 'update-status.json');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-update-status-'));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();

  ({ APP_VERSION } = await import('../../../src/utils/version.js'));
  const { default: versionRouter } = await import('../../../src/routes/version.js');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 1, username: 'testadmin', role: 'admin' };
    next();
  });
  app.use('/api/version', versionRouter);
});

afterAll(() => {
  delete process.env.DATA_DIR;
  if (tmpDir?.includes('cidrella-update-status-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

beforeEach(() => fs.rmSync(statusFile(), { force: true }));

function writeStatus(record) {
  fs.writeFileSync(statusFile(), JSON.stringify(record));
}

const completed = (from, to) => ({
  state: 'completed',
  from_version: from,
  to_version: to,
  started_at: '2026-10-18T15:27:50Z',
  updated_at: '2026-10-18T15:28:14Z',
  progress_pct: 100,
  message: `Updated to v${to}`,
  error: null,
  pid: 3087359,
});

describe('update status', () => {
  it('shows a completed update to the running version', async () => {
    writeStatus(completed('0.6.1', APP_VERSION));
    const res = await request(app).get('/api/version/update-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'completed', to_version: APP_VERSION });
  });

  it('reads a completed update to another version as idle', async () => {
    // Prod's case: the in-app update to 0.6.0 wrote this, and every update
    // since ran from the command line, which leaves the file alone.
    writeStatus(completed('0.5.3-pre.4', '0.6.0'));
    const res = await request(app).get('/api/version/update-status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
    expect(res.body.to_version).toBeUndefined();
  });

  it('keeps a failed update, which still needs dismissing', async () => {
    writeStatus({ ...completed(APP_VERSION, '9.9.9'), state: 'failed', error: 'boom' });
    const res = await request(app).get('/api/version/update-status');
    expect(res.body).toMatchObject({ state: 'failed', error: 'boom' });
  });
});
