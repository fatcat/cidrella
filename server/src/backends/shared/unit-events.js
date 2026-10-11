/**
 * What happened to a backend daemon: started (a restart), stopped, or a
 * restart that failed. createUnitControl emits here; services/audit.js
 * listens and writes the row, since an adapter never writes the database.
 * Reloads are not events: they change nothing a person would look for.
 */
import { EventEmitter } from 'events';

export const unitEvents = new EventEmitter();

/** `action` is 'restarted', 'stopped' or 'restart_failed'. */
export function emitUnitEvent(action, { unit, processName, error = null }) {
  unitEvents.emit('unit', { action, unit, processName, error });
}
