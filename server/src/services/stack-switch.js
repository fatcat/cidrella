/**
 * Moving DNS, DHCP and the Router Advertisements from one backend stack to
 * the other (STACKS in backends/index.js): dnsmasq for all three, or
 * PowerDNS, Kea and radvd. Clients see one short gap, the stop and start in
 * the middle; everything that can be done with the old stack still serving
 * is done first:
 *
 *   1. preflight: both stacks run here, and what the switch gains and loses
 *   2. the after-commit hooks and the lease sync are held, and a marker in
 *      DATA_DIR records the switch, so a crash partway is undone at boot
 *   3. stage: the target's configuration is written and checked, and its
 *      daemons that need no port the source holds are started (PowerDNS
 *      Authoritative with the zones, Kea listening nowhere)
 *   4. the source stops answering DHCP, its final leases are read and kept
 *      in DATA_DIR/handover/, and the target takes them under the same
 *      DHCPv6 server DUID
 *   5. the source stops, the target becomes the stack and starts the rest
 *   6. verify: the target holds the leases and answers for every zone
 *   7. the setting is written and the marker cleared
 *
 * A failure in steps 3 to 6 puts the source back, with any lease the target
 * handed out meanwhile. Holding the lease sync matters: a read of a backend
 * before it has the leases would release every lease in the database.
 */
import fs from 'fs';
import path from 'path';
import dnsPacket from 'dns-packet';
import { DATA_DIR, backendDnsPort } from '../config/defaults.js';
import { featureReportFor } from '../backends/contract.js';
import {
  DEFAULT_STACK,
  STACKS,
  allBackends,
  getBackend,
  selectStack,
  setDhcpServing,
  stackName,
  stackServices,
} from '../backends/index.js';
import { deleteSetting, readSetting, upsertSetting } from '../models/setting.js';
import { holdHooks } from '../utils/after-commit.js';
import { plainUdpQuery } from '../utils/plain-dns.js';
import { setSwitchInProgress, switchInProgress } from '../utils/switch-state.js';
import { nameQuery } from '../utils/upstream-probe.js';
import { applyDhcp } from './backend-apply.js';
import { holdLeaseSync } from './dhcp-lease-sync.js';

export const SETTING_KEY = 'backend_stack';
// 0.5.2's hidden DHCP-only switch. An install it left on Kea moves back to
// dnsmasq at boot, with Kea's leases.
export const LEGACY_SETTING_KEY = 'dhcp_backend';
export const MARKER_FILE = path.join(DATA_DIR, 'stack-switch.json');
const LEGACY_MARKER_FILE = path.join(DATA_DIR, 'dhcp-switch.json');
export const HANDOVER_DIR = path.join(DATA_DIR, 'handover');
// The stack in force, for scripts/rollback.sh, which cannot read the database.
export const STACK_FILE = path.join(DATA_DIR, 'runtime', 'backend-stack');

const STACK_LABELS = { dnsmasq: 'dnsmasq', 'pdns-kea': 'PowerDNS + Kea' };
export const stackLabel = (name) => STACK_LABELS[name] || name;

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

export { switchInProgress };

/** Can every daemon of `name` run here? `{ ok, reason? }`. */
export function stackInstalled(name) {
  for (const service of stackServices(name)) {
    const result = service.installed?.() ?? { ok: true };
    if (!result.ok) return result;
  }
  return { ok: true };
}

const featuresOf = (name) => featureReportFor((role) => getBackend(STACKS[name][role]));

/**
 * What switching to `target` would do, and whether it can. Read-only.
 * `blocked` is the reason it cannot, or null.
 */
export function switchPreflight(target) {
  const current = stackName();
  const stacks = Object.keys(STACKS).map((name) => ({
    name,
    label: stackLabel(name),
    daemons: stackServices(name).map((service) => service.label || service.name),
    installed: stackInstalled(name),
  }));
  if (!STACKS[target]) {
    return { current, target, stacks, blocked: `Unknown server stack: ${target}` };
  }
  const before = new Map(featuresOf(current).map((f) => [f.id, f]));
  const after = featuresOf(target);
  const describe = (f) => ({ id: f.id, role: f.role, label: f.label, note: f.note });
  const here = stacks.find((s) => s.name === current).installed;
  const there = stacks.find((s) => s.name === target).installed;
  let blocked = null;
  if (switchInProgress()) blocked = 'A server switch is already running';
  else if (target === current) blocked = `${stackLabel(target)} already serves DNS and DHCP`;
  else if (!there.ok) blocked = there.reason;
  else if (!here.ok) blocked = here.reason;
  return {
    current,
    target,
    stacks,
    blocked,
    gained: after.filter((f) => f.supported && !before.get(f.id)?.supported).map(describe),
    lost: after.filter((f) => !f.supported && before.get(f.id)?.supported).map(describe),
  };
}

function writeMarker(marker) {
  fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
  fs.writeFileSync(MARKER_FILE, JSON.stringify(marker, null, 2));
}

function readMarker(file = MARKER_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const clearMarker = () => fs.rmSync(MARKER_FILE, { force: true });

function writeStackFile(name) {
  fs.mkdirSync(path.dirname(STACK_FILE), { recursive: true });
  fs.writeFileSync(STACK_FILE, `${name}\n`);
}

// The leases, kept for an operator to recover by hand if a switch goes
// wrong in a way the rollback cannot see. 0600: they name every client.
function writeSnapshot(snapshot) {
  fs.mkdirSync(HANDOVER_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(HANDOVER_DIR, `${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  return file;
}

// A lease read is retried while the backend reports it unsettled. A backend
// that has never stored a lease has none to move.
async function settledLeases(backend, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { leases, absent } = await backend.dhcp.readLeases();
    if (leases) return leases;
    if (absent) return [];
  }
  throw new Error(`${backend.label || backend.name} leases did not settle`);
}

// Leases the target took but does not report afterwards.
async function missingLeases(backend, leases, failed) {
  const refused = new Set(failed.map((f) => f.ip));
  const now = new Set((await settledLeases(backend)).map((lease) => lease.ip));
  return leases.map((lease) => lease.ip).filter((ip) => !refused.has(ip) && !now.has(ip));
}

// Every zone answered by the DNS backend where the proxy (or, in bypass
// mode, the LAN) reaches it: an answer at all, and not SERVFAIL or REFUSED,
// which is what a zone missing from PowerDNS gets. A daemon that has just
// started may need a moment to bind, so each zone is asked a few times.
async function verifyZones(db, { attempts = 5, timeoutMs = 2000, intervalMs = 1000 } = {}) {
  const port = backendDnsPort({
    listenPort: readSetting(db, 'dns_listen_port'),
    bypass: readSetting(db, 'dns_proxy_bypass') === 'true',
    enabled: readSetting(db, 'dns_enabled') !== 'false',
  });
  if (port === null) return;
  const zones = db.prepare('SELECT name FROM dns_zones WHERE enabled = 1 ORDER BY id').all();
  const failed = [];
  for (const { name } of zones) {
    let problem = 'no answer';
    for (let i = 0; i < attempts; i++) {
      const { answer } = await plainUdpQuery('127.0.0.1', nameQuery(name, undefined, 'SOA'), {
        timeoutMs,
        port,
      });
      const rcode = answer ? dnsPacket.decode(answer).rcode : null;
      if (rcode && rcode !== 'SERVFAIL' && rcode !== 'REFUSED') {
        problem = null;
        break;
      }
      problem = rcode || 'no answer';
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (problem) failed.push(`${name} (${problem})`);
  }
  if (failed.length) throw new Error(`DNS does not answer for ${failed.join(', ')}`);
}

const backends = () => ({
  dnsmasq: getBackend('dnsmasq'),
  pdns: getBackend('pdns'),
  kea: getBackend('kea'),
  radvd: getBackend('radvd'),
});

// Stop each and wait until it has exited; the first that will not is the error.
async function stopAll(services) {
  for (const service of services) service.stop();
  for (const service of services) await service.awaitStopped();
}

async function toPdnsKea(db, st) {
  const { dnsmasq, pdns, kea, radvd } = backends();
  st.phase = 'stage';
  for (const service of [pdns, kea, radvd]) service.prepare();
  await pdns.stage(db);
  await kea.stage(db);
  await radvd.stage(db);

  // dnsmasq writes its lease file as it goes, so the file is final once it
  // has exited.
  st.phase = 'stop';
  st.sourceStopped = true;
  await stopAll([dnsmasq]);

  st.phase = 'read';
  st.leases = await settledLeases(dnsmasq);
  st.serverDuid = dnsmasq.dhcp.serverIdentity().duid;
  st.snapshot = snapshotOf(st);

  st.phase = 'import';
  const { added, failed } = await kea.dhcp.importLeases(st.leases, { serverDuid: st.serverDuid });

  st.phase = 'start';
  selectStack('pdns-kea');
  st.selected = true;
  // Kea now listens, under the server DUID; radvd's file is written and it starts.
  applyDhcp(db);
  pdns.activate();
  await kea.awaitRunning();
  await pdns.awaitRunning();
  await radvd.awaitRunning();

  st.phase = 'verify';
  const missing = await missingLeases(kea, st.leases, failed);
  await verifyZones(db);
  return { added, failed, missing };
}

async function toDnsmasq(db, st) {
  const { dnsmasq, pdns, kea, radvd } = backends();
  st.phase = 'stage';
  dnsmasq.prepare();
  await dnsmasq.stage(db);

  // Kea listening nowhere hands out nothing more, so its leases are final.
  st.phase = 'quiesce';
  setDhcpServing('kea', false);
  kea.dhcp.applyScopes(db);
  await kea.awaitRunning();

  st.phase = 'read';
  st.leases = await settledLeases(kea);
  st.serverDuid = kea.dhcp.serverIdentity().duid;
  st.snapshot = snapshotOf(st);

  // dnsmasq reads its lease file when it starts.
  st.phase = 'import';
  const { added, failed } = await dnsmasq.dhcp.importLeases(st.leases, {
    serverDuid: st.serverDuid,
  });

  st.phase = 'stop';
  st.sourceStopped = true;
  await stopAll([radvd, kea, pdns]);

  st.phase = 'start';
  selectStack('dnsmasq');
  st.selected = true;
  setDhcpServing('kea', true);
  dnsmasq.restart();
  await dnsmasq.awaitRunning();

  st.phase = 'verify';
  const missing = await missingLeases(dnsmasq, st.leases, failed);
  await verifyZones(db);
  return { added, failed, missing };
}

function snapshotOf(st) {
  const file = writeSnapshot({
    from: st.from,
    to: st.to,
    takenAt: st.startedAt,
    serverDuid: st.serverDuid,
    leases: st.leases,
  });
  writeMarker({ from: st.from, to: st.to, startedAt: st.startedAt, snapshot: file });
  return file;
}

// What the target handed out once it served, or what it was given.
async function targetLeases(target, st) {
  if (!st.selected) return null;
  try {
    return await settledLeases(target);
  } catch (err) {
    console.warn(`Could not read ${target.label} leases for the rollback:`, err.message);
    return st.leases || null;
  }
}

// dnsmasq serves again. A dnsmasq never stopped needs nothing but the
// staged daemons gone.
async function rollBackToDnsmasq(db, st) {
  const { dnsmasq, pdns, kea, radvd } = backends();
  const leases = await targetLeases(kea, st);
  selectStack('dnsmasq');
  setDhcpServing('kea', true);
  const problems = [];
  try {
    await stopAll([radvd, kea, pdns]);
  } catch (err) {
    problems.push(err.message);
  }
  if (st.sourceStopped) {
    if (leases) await dnsmasq.dhcp.importLeases(leases, { serverDuid: st.serverDuid });
    dnsmasq.restart();
    await dnsmasq.awaitRunning();
  }
  if (problems.length) throw new Error(problems.join('; '));
}

// PowerDNS, Kea and radvd serve again, with what dnsmasq handed out.
async function rollBackToPdnsKea(db, st) {
  const { dnsmasq, pdns, kea } = backends();
  const leases = await targetLeases(dnsmasq, st);
  await stopAll([dnsmasq]);
  selectStack('pdns-kea');
  setDhcpServing('kea', true);
  pdns.activate();
  kea.activate();
  applyDhcp(db);
  await kea.awaitRunning();
  if (leases) await kea.dhcp.importLeases(leases, { serverDuid: st.serverDuid });
}

function commit(db, name) {
  upsertSetting(db, SETTING_KEY, name);
  deleteSetting(db, LEGACY_SETTING_KEY);
  writeStackFile(name);
  clearMarker();
}

/**
 * Switch to the stack `target`. Resolves with what moved:
 * `{ from, to, leases, added, failed, missing, snapshot }`, where `failed`
 * lists leases the target refused and `missing` leases it took but does not
 * report afterwards. Rejects with a SwitchError, after putting the source
 * back when the switch got that far.
 */
export async function switchStack(db, target) {
  const check = switchPreflight(target);
  if (check.blocked) throw new SwitchError('preflight', check.blocked);
  setSwitchInProgress(true);
  const st = {
    from: check.current,
    to: target,
    startedAt: new Date().toISOString(),
    phase: 'hold',
    sourceStopped: false,
    selected: false,
    leases: null,
    serverDuid: null,
    snapshot: null,
  };
  let releaseHooks = null;
  let releaseLeaseSync = null;
  try {
    releaseHooks = await holdHooks();
    releaseLeaseSync = await holdLeaseSync();
    writeMarker({ from: st.from, to: target, startedAt: st.startedAt });
    const moved = target === 'pdns-kea' ? await toPdnsKea(db, st) : await toDnsmasq(db, st);
    st.phase = 'commit';
    commit(db, target);
    return {
      from: st.from,
      to: target,
      leases: st.leases.length,
      ...moved,
      snapshot: st.snapshot,
    };
  } catch (err) {
    if (st.phase === 'commit') {
      throw new SwitchError(st.phase, `The switch finished but did not record: ${err.message}`, {
        cause: err,
      });
    }
    let rollbackError = null;
    try {
      if (target === 'pdns-kea') await rollBackToDnsmasq(db, st);
      else await rollBackToPdnsKea(db, st);
      clearMarker();
    } catch (rollbackErr) {
      rollbackError = rollbackErr.message;
      console.error('Server switch rollback failed:', rollbackErr);
    }
    throw new SwitchError(st.phase, err.message, { rolledBack: true, rollbackError, cause: err });
  } finally {
    setSwitchInProgress(false);
    releaseLeaseSync?.();
    releaseHooks?.();
  }
}

// Boot, moving an install off Kea (0.5.2's switch, or a stack that cannot
// run here): Kea's leases go into dnsmasq's lease file, read through Kea's
// API while it runs, else from its lease files. Both daemons are stopped
// first; dnsmasq starts with the leases once boot activates it.
async function carryKeaLeasesToDnsmasq() {
  const { dnsmasq, kea } = backends();
  let leases = null;
  try {
    if (kea.status().running) leases = (await kea.dhcp.readLeases()).leases;
  } catch (err) {
    console.warn('Could not read leases through the Kea API:', err.message);
  }
  if (!leases) leases = kea.dhcp.readStoredLeases();
  const serverDuid = kea.dhcp.serverIdentity().duid;
  for (const service of [kea, dnsmasq]) {
    try {
      service.stop();
      await service.awaitStopped();
    } catch (err) {
      console.warn(`Could not stop ${service.label}:`, err.message);
    }
  }
  const takenAt = new Date().toISOString();
  writeSnapshot({ from: 'kea', to: 'dnsmasq', takenAt, serverDuid, leases });
  await dnsmasq.dhcp.importLeases(leases, { serverDuid });
  console.warn(`Kea served DHCP here; dnsmasq does now, with Kea's ${leases.length} leases`);
}

// Every daemon outside the stack stopped. dnsmasq is told every time, so
// its flag keeps it down across a restart; the rest only while they run.
async function stopOutside(name) {
  const keep = new Set(stackServices(name));
  for (const backend of allBackends()) {
    if (keep.has(backend)) continue;
    try {
      if (backend.name !== 'dnsmasq' && !backend.status().running) continue;
      backend.stop();
      await backend.awaitStopped();
    } catch (err) {
      console.warn(`Could not stop ${backend.label || backend.name}:`, err.message);
    }
  }
}

/**
 * Boot: choose the stack from the setting, before any backend is prepared
 * or applied. An install 0.5.2 left on Kea, or a stack that cannot run here
 * (a backup from a host with PowerDNS restored onto one without), falls back
 * to dnsmasq with Kea's leases. A switch a crash interrupted is undone: the
 * setting is written last, so it names the stack that serves. Every daemon
 * outside the stack is stopped, which also covers a restore that changed it.
 * Returns `{ stack, recovered }`, where `recovered` is null or what the
 * marker showed.
 */
export async function selectStackAtBoot(db) {
  let name = readSetting(db, SETTING_KEY);
  let carryKea = false;
  if (!name) {
    name = DEFAULT_STACK;
    carryKea = readSetting(db, LEGACY_SETTING_KEY) === 'kea';
  } else if (!STACKS[name]) {
    console.warn(`Unknown ${SETTING_KEY} '${name}'; ${DEFAULT_STACK} serves DNS and DHCP`);
    name = DEFAULT_STACK;
  }
  const installed = stackInstalled(name);
  if (!installed.ok) {
    console.error(`${installed.reason}; ${DEFAULT_STACK} serves DNS and DHCP instead`);
    carryKea = STACKS[name].dhcp === 'kea';
    name = DEFAULT_STACK;
  }

  const marker = readMarker();
  const legacyMarker = readMarker(LEGACY_MARKER_FILE);
  clearMarker();
  fs.rmSync(LEGACY_MARKER_FILE, { force: true });

  if (carryKea) await carryKeaLeasesToDnsmasq();
  selectStack(name);
  if (readSetting(db, SETTING_KEY) !== name) upsertSetting(db, SETTING_KEY, name);
  deleteSetting(db, LEGACY_SETTING_KEY);
  writeStackFile(name);
  await stopOutside(name);

  const last = marker || legacyMarker;
  if (!last) return { stack: name, recovered: null };
  const finished = marker ? marker.to === name : false;
  if (!finished) {
    console.warn(
      `A server switch from ${last.from} to ${last.to} was interrupted; ${stackLabel(name)} ` +
        `serves DNS and DHCP. The leases are in ${last.snapshot || 'no snapshot'}.`,
    );
  }
  return { stack: name, recovered: { ...last, finished } };
}
