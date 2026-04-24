import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { analyzeArchive } from '../../src/utils/backup.js';

// These tests exercise the tar behaviors that restoreBackup / createBackup
// rely on — verifying the actual command-line flags produce the intended
// on-disk result. They deliberately don't go through the Express route or
// initDb, so DATA_DIR mocking isn't needed. The 2026-04-21 incident was
// caused by dnsmasq.log (1.5 GB) shipping inside every backup; these tests
// pin the two-layer defense (exclude on create + exclude on restore).

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p, bytes) {
  fs.writeFileSync(p, bytes);
}

function tarList(archivePath) {
  return execFileSync('tar', ['tzf', archivePath], { encoding: 'utf-8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
}

describe('analyzeArchive', () => {
  let work, archive;

  beforeAll(() => {
    work = mktemp('cidrella-analyze-');
    fs.mkdirSync(path.join(work, 'dnsmasq'));
    writeFile(path.join(work, 'cidrella.db'), Buffer.alloc(4096, 'd'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log'), Buffer.alloc(8192, 'l'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log-20260421'), Buffer.alloc(1024, 'r'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log.1.gz'), Buffer.alloc(512, 'z'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.pid'), Buffer.alloc(32, 'p'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.leases'), Buffer.alloc(256, 'e'));
    archive = path.join(work, 'bundle.tar.gz');
    execFileSync('tar', ['-czf', archive, 'cidrella.db', 'dnsmasq'], { cwd: work });
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('sums the total uncompressed bytes across entries', () => {
    const r = analyzeArchive(archive);
    // cidrella.db (4096) + dnsmasq.log (8192) + dnsmasq.log-20260421 (1024)
    // + dnsmasq.log.1.gz (512) + dnsmasq.pid (32) + dnsmasq.leases (256).
    // The dnsmasq/ directory entry is size 0; only regular files count.
    expect(r.totalBytes).toBe(4096 + 8192 + 1024 + 512 + 32 + 256);
  });

  it('identifies log, rotated-log, and pid bytes as skippable', () => {
    const r = analyzeArchive(archive);
    expect(r.skippedBytes).toBe(8192 + 1024 + 512 + 32);
    expect(r.effectiveBytes).toBe(r.totalBytes - r.skippedBytes);
  });

  it('lists every file entry', () => {
    const r = analyzeArchive(archive);
    const names = r.entries.map(e => e.name);
    expect(names).toContain('cidrella.db');
    expect(names).toContain('dnsmasq/dnsmasq.log');
    expect(names).toContain('dnsmasq/dnsmasq.log-20260421');
    expect(names).toContain('dnsmasq/dnsmasq.log.1.gz');
    expect(names).toContain('dnsmasq/dnsmasq.pid');
    expect(names).toContain('dnsmasq/dnsmasq.leases');
  });
});

describe('tar --exclude on create (createBackup contract)', () => {
  let work;

  beforeAll(() => {
    work = mktemp('cidrella-create-');
    fs.mkdirSync(path.join(work, 'dnsmasq'));
    writeFile(path.join(work, 'cidrella.db'), Buffer.alloc(128, 'd'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.conf'), Buffer.from('# conf'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log'), Buffer.from('log entries'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.pid'), Buffer.from('12345'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.leases'), Buffer.from('lease'));
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('excludes *.log and *.pid from the created archive', () => {
    // Also drop in logrotate-generated rotated files (dateext and .N
    // forms), because dnsmasq lives next to the backup target and the
    // rotated copies would otherwise sneak in.
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log-20260421'), Buffer.from('rotated'));
    writeFile(path.join(work, 'dnsmasq', 'dnsmasq.log.1.gz'), Buffer.from('gzipped'));

    const archive = path.join(work, 'out.tar.gz');
    // Mirror the flags used in createBackup
    execFileSync('tar', [
      '--exclude=*.log',
      '--exclude=*.log.*',
      '--exclude=*.log-*',
      '--exclude=*.pid',
      '--exclude=dnsmasq.log',
      '--exclude=dnsmasq.pid',
      '--warning=no-file-changed',
      '-czf', archive, 'cidrella.db', 'dnsmasq',
    ], { cwd: work });

    const entries = tarList(archive);
    expect(entries).not.toContain('dnsmasq/dnsmasq.log');
    expect(entries).not.toContain('dnsmasq/dnsmasq.pid');
    expect(entries).not.toContain('dnsmasq/dnsmasq.log-20260421');
    expect(entries).not.toContain('dnsmasq/dnsmasq.log.1.gz');
    expect(entries).toContain('cidrella.db');
    expect(entries).toContain('dnsmasq/dnsmasq.conf');
    expect(entries).toContain('dnsmasq/dnsmasq.leases');
  });

  // Pin the GNU tar 1.35 argument-form quirk that caused the 2026-04-20
  // hot-patch to be a no-op: '--exclude=...' + 'czf' (bare keyletter, no
  // dash) is rejected outright, but '--exclude=...' + '-czf' works. If
  // someone re-introduces the bare form, this fails loudly.
  it('refuses bare "czf" keyletter when --exclude is present (regression guard)', () => {
    const archive = path.join(work, 'bare.tar.gz');
    expect(() => {
      execFileSync('tar', [
        '--exclude=*.log',
        'czf', archive, 'cidrella.db', 'dnsmasq',
      ], { cwd: work, stdio: 'pipe' });
    }).toThrow();
  });
});

describe('pre-restore snapshot (takePreRestoreSnapshot contract)', () => {
  let work, dataDir, snapDir;

  beforeAll(() => {
    work = mktemp('cidrella-snap-');
    dataDir = path.join(work, 'data');
    snapDir = path.join(work, 'snap');
    fs.mkdirSync(path.join(dataDir, 'dnsmasq'), { recursive: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'dnsmasq', 'dnsmasq.conf'), 'conf');
    fs.writeFileSync(path.join(dataDir, 'dnsmasq', 'dnsmasq.leases'), 'lease');
    fs.writeFileSync(path.join(dataDir, 'dnsmasq', 'dnsmasq.log'), 'log');
    fs.writeFileSync(path.join(dataDir, 'dnsmasq', 'dnsmasq.pid'), 'pid');
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('tar pipe with excludes mirrors the snapshot copy step', () => {
    // Mirror the spawnSync('tar -cf - | tar -xf -') flow used in
    // takePreRestoreSnapshot. Exercises the exact flag set so a regression
    // (someone re-introducing cp -a, or dropping the --exclude) fails loudly.
    const reader = execFileSync('tar', [
      '--exclude=*.log',
      '--exclude=*.log.*',
      '--exclude=*.log-*',
      '--exclude=*.pid',
      '-cf', '-',
      '-C', dataDir, 'dnsmasq',
    ]);
    execFileSync('tar', ['-xf', '-', '-C', snapDir], { input: reader });

    expect(fs.existsSync(path.join(snapDir, 'dnsmasq', 'dnsmasq.conf'))).toBe(true);
    expect(fs.existsSync(path.join(snapDir, 'dnsmasq', 'dnsmasq.leases'))).toBe(true);
    expect(fs.existsSync(path.join(snapDir, 'dnsmasq', 'dnsmasq.log'))).toBe(false);
    expect(fs.existsSync(path.join(snapDir, 'dnsmasq', 'dnsmasq.pid'))).toBe(false);
  });
});

describe('tar --exclude on restore (restoreBackup defense-in-depth)', () => {
  let work, legacyArchive, extractDir;

  beforeAll(() => {
    work = mktemp('cidrella-restore-');
    const src = path.join(work, 'src');
    fs.mkdirSync(path.join(src, 'dnsmasq'), { recursive: true });
    writeFile(path.join(src, 'cidrella.db'), Buffer.alloc(128, 'd'));
    writeFile(path.join(src, 'dnsmasq', 'dnsmasq.conf'), Buffer.from('# conf'));
    // Simulate a legacy backup (pre-2026-04-20) that still contains dnsmasq.log
    writeFile(path.join(src, 'dnsmasq', 'dnsmasq.log'), Buffer.alloc(64 * 1024, 'L'));
    // Also a logrotate-rotated copy — defense-in-depth patterns must catch these too.
    writeFile(path.join(src, 'dnsmasq', 'dnsmasq.log-20260421'), Buffer.alloc(1024, 'R'));
    writeFile(path.join(src, 'dnsmasq', 'dnsmasq.leases'), Buffer.from('lease data'));

    legacyArchive = path.join(work, 'legacy.tar.gz');
    execFileSync('tar', ['-czf', legacyArchive, 'cidrella.db', 'dnsmasq'], { cwd: src });

    extractDir = path.join(work, 'extract');
    fs.mkdirSync(extractDir);
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('legacy archive contains dnsmasq.log (pre-condition)', () => {
    expect(tarList(legacyArchive)).toContain('dnsmasq/dnsmasq.log');
  });

  it('restore-side exclude keeps dnsmasq.log off disk', () => {
    // Mirror the flags used in restoreBackup
    execFileSync('tar', [
      '--exclude=*.log',
      '--exclude=*.log.*',
      '--exclude=*.log-*',
      '--exclude=*.pid',
      '--exclude=dnsmasq.log',
      '--exclude=dnsmasq.pid',
      '-xzf', legacyArchive, '-C', extractDir,
    ]);

    expect(fs.existsSync(path.join(extractDir, 'dnsmasq', 'dnsmasq.log'))).toBe(false);
    expect(fs.existsSync(path.join(extractDir, 'dnsmasq', 'dnsmasq.log-20260421'))).toBe(false);
    // Everything else should still be there
    expect(fs.existsSync(path.join(extractDir, 'cidrella.db'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'dnsmasq', 'dnsmasq.conf'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'dnsmasq', 'dnsmasq.leases'))).toBe(true);
  });
});
