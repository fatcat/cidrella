import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-version-report-'));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();

  const { default: versionRouter } = await import('../../../src/routes/version.js');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      id: 1,
      username: 'testadmin',
      role: req.get('x-test-role') || 'admin'
    };
    next();
  });
  app.use('/api/version', versionRouter);
});

afterAll(() => {
  delete process.env.DATA_DIR;
  if (tmpDir?.includes('cidrella-version-report-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('IP lifecycle migration report download', () => {
  it('advertises and downloads the report for administrators', async () => {
    const idle = await request(app).get('/api/version/update-status');
    expect(idle.status).toBe(200);
    expect(idle.body.lifecycle_migration_report_available).toBe(false);
    expect(idle.body.lifecycle_migration_report_download).toBeNull();

    const report = {
      outcome: 'blocked',
      conflicts: [{
        reason: 'Hosts printer.example.com and cups.example.com are A records for the same IP 192.0.2.20.',
        remediation: 'Keep one A record and convert the other host to a CNAME.'
      }]
    };
    fs.writeFileSync(
      path.join(tmpDir, 'ip-lifecycle-migration-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    );

    const status = await request(app).get('/api/version/update-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      lifecycle_migration_report_available: true,
      lifecycle_migration_report_download: '/api/version/ip-lifecycle-migration-report'
    });

    const download = await request(app).get('/api/version/ip-lifecycle-migration-report');
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/json/);
    expect(download.headers['content-disposition'])
      .toBe('attachment; filename="ip-lifecycle-migration-report.json"');
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.body).toEqual(report);
  });

  it('does not expose the report to non-administrators', async () => {
    const response = await request(app)
      .get('/api/version/ip-lifecycle-migration-report')
      .set('x-test-role', 'readonly');
    expect(response.status).toBe(403);
  });

  it('refuses a symlink in place of the generated report', async () => {
    const reportPath = path.join(tmpDir, 'ip-lifecycle-migration-report.json');
    const otherPath = path.join(tmpDir, 'other.json');
    fs.unlinkSync(reportPath);
    fs.writeFileSync(otherPath, '{"not":"a migration report"}\n');
    fs.symlinkSync(otherPath, reportPath);

    const status = await request(app).get('/api/version/update-status');
    expect(status.body.lifecycle_migration_report_available).toBe(false);

    const response = await request(app).get('/api/version/ip-lifecycle-migration-report');
    expect(response.status).toBe(404);
  });
});
