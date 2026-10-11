/**
 * Audit rows for what the backends do on their own: a daemon started, stopped
 * or failed to restart. A person's edit that restarts one is theirs (the
 * request context carries through); a restart at boot or by the health check
 * is the system's, with source 'backend'. Started once at boot.
 *
 * Two quiet spells: while a server switch runs (its own row says what moved)
 * and while CIDRella boots (starting its daemons is what booting is), when only
 * a failure is recorded.
 */
import { onUnitEvent } from '../backends/index.js';
import { switchInProgress } from '../utils/switch-state.js';
import { recordAudit } from './audit.js';

const ACTIONS = {
  restarted: 'backend_daemon_restarted',
  stopped: 'backend_daemon_stopped',
  restart_failed: 'backend_daemon_restart_failed',
};

let unsubscribe = null;
let booting = false;

export function startSystemAudit({ boot = false } = {}) {
  booting = boot;
  if (unsubscribe) return;
  unsubscribe = onUnitEvent(({ action, unit, processName, error }) => {
    if (switchInProgress()) return;
    if (booting && action !== 'restart_failed') return;
    try {
      recordAudit({
        action: ACTIONS[action] || `backend_daemon_${action}`,
        entityType: 'backend',
        source: 'backend',
        details: { unit, process: processName, ...(error ? { error } : {}) },
      });
    } catch (err) {
      // A daemon event must never fail the work that caused it.
      console.warn('Could not record a daemon event:', err.message);
    }
  });
}

/** Boot is over: every daemon event is recorded from now on. */
export function systemAuditBooted() {
  booting = false;
}

export function stopSystemAudit() {
  unsubscribe?.();
  unsubscribe = null;
}
