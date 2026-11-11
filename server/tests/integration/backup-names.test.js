/**
 * Backup file names come from the backup_name_template setting, and a backup
 * is recognized by the manifest it carries, never by its name.
 */
// First: the modules below read DATA_DIR when they load.
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { cleanupTestDb } from '../helpers/test-db.js';
import { createTestApp } from '../helpers/test-app.js';
import { getDb, initDb } from '../../src/db/init.js';
import {
  chooseBackupName,
  createBackup,
  deleteBackup,
  listBackups,
  readLeadingManifest,
} from '../../src/utils/backup.js';
import { stackName } from '../../src/backends/index.js';
import { APP_VERSION } from '../../src/utils/version.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
let db;

const setTemplate = (value) =>
  db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('backup_name_template', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(value);

function clearBackups() {
  for (const row of db.prepare('SELECT id FROM backups').all()) deleteBackup(db, row.id);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// A gzipped tar of `files` (name -> content), in that order.
function makeArchive(target, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-names-'));
  try {
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(dir, name), content);
    execFileSync('tar', ['-czf', target, '-C', dir, ...Object.keys(files)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const manifestJson = (fields = {}) =>
  JSON.stringify({
    type: 'cidrella-backup',
    cidrella_version: '0.6.3',
    schema_version: 94,
    created_at: '2026-10-01T08:00:00.000Z',
    includes: ['cidrella.db'],
    ...fields,
  });

const listed = () => listBackups(db).map((b) => b.filename);

beforeAll(async () => {
  await initDb(DATA_DIR);
  db = getDb();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db.prepare("UPDATE settings SET value = '365' WHERE key = 'backup_retention_count'").run();
});

beforeEach(() => {
  clearBackups();
  db.prepare("DELETE FROM settings WHERE key = 'backup_name_template'").run();
});

afterAll(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  cleanupTestDb(DATA_DIR);
});

describe('the name a backup is given', () => {
  it('keeps the old name with no template stored', async () => {
    const backup = await createBackup(db);
    expect(backup.filename).toMatch(/^cidrella-backup-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.tar\.gz$/);
    expect(fs.readdirSync(BACKUP_DIR)).toEqual([backup.filename]);
  }, 60_000);

  it('fills in every variable, and counts from -00 when the name repeats', async () => {
    setTemplate('{{hostname}}-{{version}}-s{{schema}}-{{stack}}-{{trigger}}');
    const schema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    const base = `${os.hostname()}-${APP_VERSION}-s${schema}-${stackName()}`;
    const names = [];
    names.push((await createBackup(db)).filename);
    names.push((await createBackup(db, { trigger: 'manual' })).filename);
    names.push((await createBackup(db, { trigger: 'scheduled' })).filename);
    expect(names).toEqual([
      `${base}-manual-00.tar.gz`,
      `${base}-manual-01.tar.gz`,
      `${base}-scheduled-00.tar.gz`,
    ]);
    expect(readLeadingManifest(path.join(BACKUP_DIR, names[0]))).toMatchObject({
      type: 'cidrella-backup',
      cidrella_version: APP_VERSION,
      schema_version: schema,
    });
    // No archive is left half-written under a dotfile.
    expect(fs.readdirSync(BACKUP_DIR).sort()).toEqual([...names].sort());
  }, 60_000);

  it('falls back to the default for a stored template that is not valid', async () => {
    setTemplate('../escape');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backup = await createBackup(db);
    expect(backup.filename).toMatch(/^cidrella-backup-/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not valid'));
    warn.mockRestore();
  }, 60_000);
});

describe('the counter', () => {
  const values = { hostname: 'h', date: '2026-11-11', time: '13-42-09' };
  const takenSet = (names) => (name) => names.has(name);

  it('takes the next after the highest in use', () => {
    const used = new Set(['h-00.tar.gz', 'h-01.tar.gz', 'h-05.tar.gz']);
    expect(chooseBackupName('{{hostname}}', values, takenSet(used))).toBe('h-06.tar.gz');
  });

  it('after FF, takes the lowest that retention freed', () => {
    const used = new Set(
      Array.from(
        { length: 256 },
        (_, n) => `h-${n.toString(16).toUpperCase().padStart(2, '0')}.tar.gz`,
      ),
    );
    used.delete('h-03.tar.gz');
    used.delete('h-07.tar.gz');
    expect(chooseBackupName('{{hostname}}', values, takenSet(used))).toBe('h-03.tar.gz');
  });

  it('refuses with a clear message when all 256 are in use', () => {
    const all = () => true;
    expect(() => chooseBackupName('{{hostname}}', values, all)).toThrow(
      /Every name the backup file name template "\{\{hostname\}\}" gives is in use \(h-00 to -FF\)/,
    );
  });

  it('adds nothing to a unique template, unless the same second repeats', () => {
    const template = 'x-{{date}}_{{time}}';
    expect(chooseBackupName(template, values, () => false)).toBe('x-2026-11-11_13-42-09.tar.gz');
    const used = new Set(['x-2026-11-11_13-42-09.tar.gz']);
    expect(chooseBackupName(template, values, takenSet(used))).toBe(
      'x-2026-11-11_13-42-09-00.tar.gz',
    );
  });
});

describe('finding backups the table does not list', () => {
  it('takes up a backup by its manifest, whatever it is called, dated by the manifest', async () => {
    const original = (await createBackup(db)).filename;
    for (const name of ['renamed.tar.gz', 'no-extension']) {
      fs.copyFileSync(path.join(BACKUP_DIR, original), path.join(BACKUP_DIR, name));
    }
    makeArchive(path.join(BACKUP_DIR, 'copied-in.tgz'), {
      'cidrella-backup-manifest.json': manifestJson(),
      'cidrella.db': 'x',
    });
    expect(listed()).toEqual(
      expect.arrayContaining([original, 'renamed.tar.gz', 'no-extension', 'copied-in.tgz']),
    );
    const copied = db
      .prepare("SELECT created_at FROM backups WHERE filename = 'copied-in.tgz'")
      .get();
    expect(copied.created_at).toBe('2026-10-01 08:00:00');
  }, 60_000);

  it('leaves alone anything that is not a CIDRella backup', async () => {
    const real = (await createBackup(db)).filename;
    const realBytes = fs.readFileSync(path.join(BACKUP_DIR, real));
    makeArchive(path.join(BACKUP_DIR, 'other-first.tar.gz'), {
      'cidrella.db': 'x',
      'cidrella-backup-manifest.json': manifestJson(),
    });
    makeArchive(path.join(BACKUP_DIR, 'other-type.tar.gz'), {
      'cidrella-backup-manifest.json': manifestJson({ type: 'something-else' }),
    });
    fs.writeFileSync(path.join(BACKUP_DIR, 'notes.txt'), 'not an archive');
    fs.writeFileSync(path.join(BACKUP_DIR, 'empty.tar.gz'), '');
    fs.writeFileSync(path.join(BACKUP_DIR, 'truncated.tar.gz'), realBytes.subarray(0, 20));
    fs.writeFileSync(path.join(BACKUP_DIR, '.hidden.tar.gz'), realBytes);
    fs.writeFileSync(path.join(BACKUP_DIR, `.${real}x.partial`), realBytes);
    fs.writeFileSync(path.join(BACKUP_DIR, 'junk.gz'), zlib.gzipSync('not tar at all'));
    expect(listed()).toEqual([real]);
  }, 60_000);

  it('still takes up an old backup with no manifest by its old name', () => {
    makeArchive(path.join(BACKUP_DIR, 'cidrella-backup-2026-01-01_00-00-00.tar.gz'), {
      'cidrella.db': 'x',
    });
    makeArchive(path.join(BACKUP_DIR, 'unknown.tar.gz'), { 'cidrella.db': 'x' });
    expect(listed()).toEqual(['cidrella-backup-2026-01-01_00-00-00.tar.gz']);
  });

  it('reads no more than the first 64 KiB of an archive', () => {
    const target = path.join(BACKUP_DIR, 'large.tar.gz');
    makeArchive(target, {
      'cidrella-backup-manifest.json': manifestJson(),
      // Random, so gzip cannot shrink it below what the reader must not read.
      'cidrella.db': crypto.randomBytes(1024 * 1024),
    });
    expect(fs.statSync(target).size).toBeGreaterThan(256 * 1024);
    const reads = vi.spyOn(fs, 'readSync');
    expect(readLeadingManifest(target)).toMatchObject({ type: 'cidrella-backup' });
    const bytes = reads.mock.calls.reduce((sum, call) => sum + (call[3] ?? 0), 0);
    reads.mockRestore();
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('GET /api/operations/backups/name-values', () => {
  it('gives an administrator what a template is filled with now', async () => {
    const { default: operationsRouter } = await import('../../src/routes/operations.js');
    const { default: request } = await import('supertest');
    const admin = createTestApp(operationsRouter, '/api/operations');
    const res = await request(admin).get('/api/operations/backups/name-values');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hostname: os.hostname(),
      version: APP_VERSION,
      stack: stackName(),
      schema: db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
    });
    expect(res.body.date).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(res.body.time).toMatch(/^\d\d-\d\d-\d\d$/);

    const viewer = createTestApp(operationsRouter, '/api/operations', {
      id: 2,
      role: 'readonly',
      username: 'viewer',
    });
    expect((await request(viewer).get('/api/operations/backups/name-values')).status).toBe(403);
  });
});
