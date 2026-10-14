/**
 * The audit rows for a daemon starting and stopping (services/system-audit.js):
 * a person's edit that restarts one is theirs, the rest is the system's, and
 * boot and a server switch stay quiet but for a failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../../helpers/test-db.js';
import { emitUnitEvent } from '../../../../src/backends/shared/unit-events.js';
import {
  startSystemAudit,
  stopSystemAudit,
  systemAuditBooted,
} from '../../../../src/services/system-audit.js';
import { setSwitchInProgress } from '../../../../src/utils/switch-state.js';
import { actorMiddleware } from '../../../../src/utils/request-actor.js';

const daemon = { unit: 'cidrella-dnsmasq', processName: 'dnsmasq' };

describe('daemon audit rows', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    ({ db, tmpDir } = await setupTestDb());
  });
  afterEach(() => {
    stopSystemAudit();
    setSwitchInProgress(false);
    cleanupTestDb(tmpDir);
  });

  const rows = () =>
    db
      .prepare("SELECT actor, origin, source, action FROM audit_log WHERE entity_type = 'backend'")
      .all();

  it('gives a restart a person caused to that person', () => {
    startSystemAudit();
    actorMiddleware({ user: { id: 1, username: 'admin' }, ip: '10.0.0.9' }, null, () =>
      emitUnitEvent('restarted', daemon),
    );
    expect(rows()).toEqual([
      { actor: 'admin', origin: 'ui', source: null, action: 'backend_daemon_restarted' },
    ]);
  });

  it('gives one nobody asked for to the system', () => {
    startSystemAudit();
    emitUnitEvent('stopped', daemon);
    expect(rows()).toEqual([
      { actor: 'system', origin: 'system', source: 'backend', action: 'backend_daemon_stopped' },
    ]);
  });

  it('records only failures while booting', () => {
    startSystemAudit({ boot: true });
    emitUnitEvent('restarted', daemon);
    emitUnitEvent('restart_failed', { ...daemon, error: 'unit not found' });
    systemAuditBooted();
    emitUnitEvent('restarted', daemon);
    expect(rows().map((row) => row.action)).toEqual([
      'backend_daemon_restart_failed',
      'backend_daemon_restarted',
    ]);
  });

  it('leaves a server switch to its own row', () => {
    startSystemAudit();
    setSwitchInProgress(true);
    emitUnitEvent('stopped', daemon);
    expect(rows()).toEqual([]);
  });
});
