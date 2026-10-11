import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  LAST_VERSION_KEY,
  lastUpdaterRun,
  recordVersionChange,
} from '../../../src/services/version-audit.js';
import { readSetting, upsertSetting } from '../../../src/models/setting.js';
import { recordAudit } from '../../../src/services/audit.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const line = (minutesAgo, phase, event, data = {}) =>
  JSON.stringify({ ts: at(minutesAgo), phase, event, data });

// What update.sh writes for an update from 0.5.2 to 0.5.3 (scripts/lib/log.sh).
const updateRun = (minutesAgo = 5) =>
  [
    line(minutesAgo, 'update', 'start', { pid: '1' }),
    line(minutesAgo - 1, 'preflight', 'pass', { from_version: '0.5.2' }),
    line(minutesAgo - 2, 'download', 'pass', { tag: 'v0.5.3' }),
    line(minutesAgo - 2, 'verify', 'pass', { release_json_version: '0.5.3' }),
    line(minutesAgo - 3, 'switchover', 'pass', { active_slot: 'b' }),
  ].join('\n');

describe('lastUpdaterRun', () => {
  it('reads an update with its versions', () => {
    expect(lastUpdaterRun(updateRun(), { now: NOW })).toMatchObject({
      how: 'update',
      from: '0.5.2',
      to: '0.5.3',
    });
  });

  it('reads a rollback after the update it undid', () => {
    const text = `${updateRun(10)}\n${line(2, 'rollback', 'start', { from: '0.5.3', to: '0.5.2' })}`;
    expect(lastUpdaterRun(text, { now: NOW })).toMatchObject({
      how: 'rollback',
      from: '0.5.3',
      to: '0.5.2',
    });
  });

  it('ignores a run too old to have caused this boot, and a cut first line', () => {
    expect(lastUpdaterRun(updateRun(60 * 24), { now: NOW })).toBeNull();
    expect(lastUpdaterRun(`"phase":"upd\n${updateRun()}`, { now: NOW })).not.toBeNull();
    expect(lastUpdaterRun('', { now: NOW })).toBeNull();
  });
});

describe('recordVersionChange', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await setupTestDb());
  });
  afterEach(() => cleanupTestDb(tmpDir));

  const rows = () =>
    db
      .prepare("SELECT * FROM audit_log WHERE action = 'version_changed' ORDER BY id")
      .all()
      .map((row) => ({ ...row, details: JSON.parse(row.details) }));
  const writeEvents = (text) => fs.writeFileSync(path.join(tmpDir, 'events.jsonl'), `${text}\n`);
  // The log's runs are dated now, so the 6 hour window holds them.
  const recent = (text) => text.replaceAll(/"ts":"[^"]+"/g, `"ts":"${new Date().toISOString()}"`);

  it('remembers the first version it sees without a row', () => {
    expect(recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir })).toBeNull();
    expect(readSetting(db, LAST_VERSION_KEY)).toBe('0.5.3');
    expect(rows()).toEqual([]);
  });

  it('records an update run from a shell', () => {
    upsertSetting(db, LAST_VERSION_KEY, '0.5.2');
    writeEvents(recent(updateRun()));
    recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir });
    expect(rows()).toMatchObject([
      {
        actor: 'system',
        origin: 'cli',
        source: 'update',
        details: { from: '0.5.2', to: '0.5.3', how: 'update' },
      },
    ]);
    // A second boot of the same version adds nothing.
    recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir });
    expect(rows()).toHaveLength(1);
  });

  it('names the person who started the update in the UI', () => {
    upsertSetting(db, LAST_VERSION_KEY, '0.5.2');
    writeEvents(recent(updateRun()));
    recordAudit({
      action: 'update_started',
      actor: 'admin',
      details: { from_version: '0.5.2', to_version: '0.5.3' },
    });
    recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir });
    expect(rows()).toMatchObject([{ actor: 'admin', origin: 'ui' }]);
  });

  it('records a rollback that restored the database from before the update', () => {
    // The snapshot still names 0.5.2 as the last version.
    upsertSetting(db, LAST_VERSION_KEY, '0.5.2');
    writeEvents(
      recent(`${updateRun(10)}\n${line(2, 'rollback', 'start', { from: '0.5.3', to: '0.5.2' })}`),
    );
    recordVersionChange(db, { version: '0.5.2', dataDir: tmpDir });
    expect(rows()).toMatchObject([
      {
        origin: 'cli',
        source: 'rollback',
        details: { from: '0.5.3', to: '0.5.2', how: 'rollback' },
      },
    ]);
    recordVersionChange(db, { version: '0.5.2', dataDir: tmpDir });
    expect(rows()).toHaveLength(1);
  });

  it('records a new image with no event log as a change of unknown cause', () => {
    upsertSetting(db, LAST_VERSION_KEY, '0.5.2');
    recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir });
    expect(rows()).toMatchObject([
      { origin: 'system', source: 'boot', details: { from: '0.5.2', to: '0.5.3', how: 'unknown' } },
    ]);
  });

  it('ignores an updater run that ended on another version', () => {
    writeEvents(recent(updateRun()));
    expect(recordVersionChange(db, { version: '0.5.4', dataDir: tmpDir })).toBeNull();
    upsertSetting(db, LAST_VERSION_KEY, '0.5.3');
    recordVersionChange(db, { version: '0.5.4', dataDir: tmpDir });
    expect(rows()).toMatchObject([
      { origin: 'system', details: { from: '0.5.3', how: 'unknown' } },
    ]);
  });

  it('writes nothing when the run started on this version', () => {
    writeEvents(recent(updateRun().replace('"from_version":"0.5.2"', '"from_version":"0.5.3"')));
    expect(recordVersionChange(db, { version: '0.5.3', dataDir: tmpDir })).toBeNull();
    expect(rows()).toEqual([]);
  });
});
