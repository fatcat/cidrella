/**
 * Moving the DHCP role from one backend to another (dnsmasq and Kea), with
 * the leases. The order keeps exactly one server answering, or none for the
 * moment between:
 *
 *   1. preflight: the target can run here, and what the switch gains and loses
 *   2. a marker in DATA_DIR, so a crash partway is undone at the next boot
 *   3. the source stops answering DHCP (it keeps running: dnsmasq still
 *      serves DNS and the Router Advertisements)
 *   4. its final lease set is read and kept in DATA_DIR/handover/
 *   5. the target starts, answering nothing, and takes the leases under the
 *      same DHCPv6 server DUID
 *   6. the target answers DHCP
 *   7. the setting is written, the marker cleared, a source that fills no
 *      role any more is stopped
 *
 * A failure in steps 3 to 6 puts the source back. The lease sync is held for
 * the whole switch: a read of the target before it has the leases would
 * release every lease in the database.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/defaults.js';
import { featureReportFor } from '../backends/contract.js';
import {
  DEFAULT_DHCP_BACKEND,
  DHCP_BACKENDS,
  dhcpBackendName,
  getBackend,
  getService,
  selectDhcpBackend,
  setDhcpServing,
  uniqueServices,
} from '../backends/index.js';
import { readSetting, upsertSetting } from '../models/setting.js';
import { applyDhcp } from './backend-apply.js';
import { holdLeaseSync } from './dhcp-lease-sync.js';

export const SETTING_KEY = 'dhcp_backend';
export const MARKER_FILE = path.join(DATA_DIR, 'dhcp-switch.json');
export const HANDOVER_DIR = path.join(DATA_DIR, 'handover');

const LABELS = { dnsmasq: 'dnsmasq', kea: 'Kea' };
export const backendLabel = (name) => LABELS[name] || name;

/** A switch that stopped, with the step it stopped in. */
export class SwitchError extends Error {
  constructor(phase, message, { rolledBack = false, rollbackError = null, cause } = {}) {
    super(message, { cause });
    this.name = 'SwitchError';
    this.phase = phase;
    this.rolledBack = rolledBack;
    this.rollbackError = rollbackError;
  }
}

let switching = false;
export const switchInProgress = () => switching;

const isInstalled = (name) => getBackend(name).installed?.() ?? { ok: true };

// The DHCP features `name` supports, as the feature report gives them.
function dhcpFeatures(name) {
  return featureReportFor((role) => (role === 'dhcp' ? getBackend(name) : getService(role))).filter(
    (f) => f.role === 'dhcp',
  );
}

/**
 * What switching to `target` would do, and whether it can. Read-only.
 * `blocked` is the reason it cannot, or null.
 */
export function switchPreflight(target) {
  const current = dhcpBackendName();
  const options = DHCP_BACKENDS.map((name) => ({
    name,
    label: backendLabel(name),
    installed: isInstalled(name),
  }));
  if (!DHCP_BACKENDS.includes(target)) {
    return { current, target, options, blocked: `Unknown DHCP server: ${target}` };
  }
  const installed = isInstalled(target);
  const before = new Map(dhcpFeatures(current).map((f) => [f.id, f]));
  const after = dhcpFeatures(target);
  const describe = (f) => ({ id: f.id, label: f.label, note: f.note });
  let blocked = null;
  if (switching) blocked = 'A DHCP server switch is already running';
  else if (target === current) blocked = `${backendLabel(target)} already serves DHCP`;
  else if (!installed.ok) blocked = installed.reason;
  return {
    current,
    target,
    options,
    blocked,
    gained: after.filter((f) => f.supported && !before.get(f.id)?.supported).map(describe),
    lost: after.filter((f) => !f.supported && before.get(f.id)?.supported).map(describe),
  };
}

function writeMarker(marker) {
  fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
  fs.writeFileSync(MARKER_FILE, JSON.stringify(marker, null, 2));
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const clearMarker = () => fs.rmSync(MARKER_FILE, { force: true });

// The leases, kept for an operator to recover by hand if a switch goes
// wrong in a way the rollback cannot see. 0600: they name every client.
function writeSnapshot(snapshot) {
  fs.mkdirSync(HANDOVER_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(HANDOVER_DIR, `${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  return file;
}

// A lease read is retried while the backend reports it unsettled.
async function settledLeases(backend, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { leases } = await backend.dhcp.readLeases();
    if (leases) return leases;
  }
  throw new Error(`${backendLabel(backend.name)} leases did not settle`);
}

/**
 * Switch the DHCP role to `target`. Resolves with what moved:
 * `{ from, to, leases, added, failed, missing, snapshot }`, where `failed`
 * lists leases the target refused and `missing` leases it took but does not
 * report afterwards. Rejects with a SwitchError, after putting the source
 * back when the switch got that far.
 */
export async function switchDhcpBackend(db, target) {
  const check = switchPreflight(target);
  if (check.blocked) throw new SwitchError('preflight', check.blocked);
  switching = true;
  const from = check.current;
  const source = getBackend(from);
  const dest = getBackend(target);
  const startedAt = new Date().toISOString();
  const releaseLeaseSync = await holdLeaseSync();
  let phase = 'quiesce';
  try {
    writeMarker({ from, to: target, startedAt });

    setDhcpServing(from, false);
    applyDhcp(db);

    phase = 'read';
    const leases = await settledLeases(source);
    const serverDuid = source.dhcp.serverIdentity().duid;
    const snapshot = writeSnapshot({ from, to: target, takenAt: startedAt, serverDuid, leases });
    writeMarker({ from, to: target, startedAt, snapshot });

    phase = 'import';
    setDhcpServing(target, false);
    selectDhcpBackend(target);
    dest.prepare();
    applyDhcp(db);
    dest.activate();
    await dest.awaitRunning?.();
    const { added, failed } = await dest.dhcp.importLeases(leases, { serverDuid });

    phase = 'serve';
    setDhcpServing(target, true);
    applyDhcp(db);
    await dest.awaitRunning?.();

    phase = 'verify';
    const refused = new Set(failed.map((f) => f.ip));
    const now = new Set((await settledLeases(dest)).map((lease) => lease.ip));
    const missing = leases
      .map((lease) => lease.ip)
      .filter((ip) => !refused.has(ip) && !now.has(ip));

    phase = 'commit';
    upsertSetting(db, SETTING_KEY, target);
    setDhcpServing(from, true);
    if (!uniqueServices().includes(source)) source.stop?.();
    clearMarker();
    return { from, to: target, leases: leases.length, added, failed, missing, snapshot };
  } catch (err) {
    if (phase === 'commit') {
      throw new SwitchError(phase, `The switch finished but did not record: ${err.message}`, {
        cause: err,
      });
    }
    let rollbackError = null;
    try {
      rollBack(db, from, target);
    } catch (rollbackErr) {
      rollbackError = rollbackErr.message;
      console.error('DHCP server switch rollback failed:', rollbackErr);
    }
    throw new SwitchError(phase, err.message, { rolledBack: true, rollbackError, cause: err });
  } finally {
    switching = false;
    releaseLeaseSync();
  }
}

// The source answers DHCP again; the target, if it fills no role, stops.
function rollBack(db, from, target) {
  setDhcpServing(target, true);
  setDhcpServing(from, true);
  selectDhcpBackend(from);
  applyDhcp(db);
  const dest = getBackend(target);
  if (!uniqueServices().includes(dest)) dest.stop?.();
  clearMarker();
}

/**
 * Boot: choose the DHCP backend from the setting, undoing a switch a crash
 * interrupted. Called after the database opens and before any backend is
 * prepared or applied. A setting naming a backend that cannot run here (a
 * backup from a host with Kea restored onto one without) falls back to
 * dnsmasq and says so. Returns `{ backend, recovered }`, where `recovered` is
 * null or what the marker showed.
 */
export function selectDhcpBackendAtBoot(db) {
  let name = readSetting(db, SETTING_KEY) || DEFAULT_DHCP_BACKEND;
  if (!DHCP_BACKENDS.includes(name)) {
    console.warn(`Unknown ${SETTING_KEY} '${name}'; DHCP stays with ${DEFAULT_DHCP_BACKEND}`);
    name = DEFAULT_DHCP_BACKEND;
  }
  const installed = isInstalled(name);
  if (!installed.ok) {
    console.error(`${installed.reason}; DHCP falls back to ${DEFAULT_DHCP_BACKEND}`);
    name = DEFAULT_DHCP_BACKEND;
    upsertSetting(db, SETTING_KEY, name);
  }
  selectDhcpBackend(name);

  const marker = readMarker();
  if (!marker) return { backend: name, recovered: null };
  clearMarker();
  // The setting is written last, so a setting naming the target means the
  // switch finished and only the cleanup was lost.
  const finished = marker.to === name;
  for (const other of DHCP_BACKENDS) {
    if (other === name) continue;
    const backend = getBackend(other);
    if (!uniqueServices().includes(backend)) {
      try {
        backend.stop?.();
      } catch (err) {
        console.warn(`Could not stop ${other}:`, err.message);
      }
    }
  }
  if (!finished) {
    console.warn(
      `A switch of the DHCP server from ${marker.from} to ${marker.to} was interrupted; ` +
        `${name} serves DHCP. Its leases are in ${marker.snapshot || 'no snapshot'}.`,
    );
  }
  return { backend: name, recovered: { ...marker, finished } };
}
