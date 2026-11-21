/**
 * A member's side of the sync: joining a controller, and then following it.
 *
 * Joining trades a join token for a credential over a connection pinned to
 * the certificate the token names, takes the controller's whole dataset, and
 * turns this box into a member. Following is one request at a time: ask for
 * what is missing, wait on the controller when nothing is, apply what comes,
 * and tell the DNS proxy what changed under it.
 *
 * The controller can change (services/controller-promotion.js). A member
 * notices because the one it follows says so, stops answering, or is outbid
 * by another instance at a higher epoch, and then follows the new one
 * (sync/find-controller.js) from the cursor it has.
 */
import fs from 'fs';
import path from 'path';
import { getHttpsPort } from '../utils/http-server.js';
import { syncRequest } from '../utils/sync-client.js';
import { APP_VERSION } from '../utils/version.js';
import {
  SETUP_STATE_KEY,
  deleteSetting,
  setSetupState,
  upsertSettingWithConflict,
} from '../models/setting.js';
import { ownInstanceId, ownInstanceName, parseJoinToken } from '../models/sync-instance.js';
import { refreshAllEnabled } from '../utils/blocklist.js';
import {
  loadAllowlist,
  loadBlocklist,
  loadFilteringOverrides,
  loadGeoipAllowlist,
  listenAddresses,
  loadGeoipRules,
  refreshProxyConfig,
} from '../utils/dns-proxy.js';
import { recordAudit } from '../services/audit.js';
import { applyChanges, parseChanges, SyncError } from './changes.js';
import {
  callController,
  doubtIn,
  answerEpoch,
  FENCED,
  jsonBody,
  lineageEpoch,
  NOT_CONTROLLER,
  onControllerDoubt,
  STALE_EPOCH,
} from './controller-call.js';
import { CREDENTIAL_FILE, readCredential, syncDirOf } from './credential.js';
import { dhcpStateChanged } from './dhcp-active.js';
import { findController } from './find-controller.js';
import { syncFingerprint } from './identity.js';
import { ensureSyncTriggers, MEMBER, readSyncState, syncStatus, writeSyncState } from './log.js';
import { controllerOf } from './mode.js';
import { fencedState, setFenced } from './promotion-state.js';
import { restartSoon } from './restart.js';
import { flushSeen } from './remote-sink.js';

const WAIT_SECONDS = 25;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const PAUSED_RETRY_MS = 60_000;
// A forced promotion is noticed within this long even while the controller
// this member follows still answers.
const SEARCH_INTERVAL_MS = 60_000;
// Rounds the controller may fail to answer before the member asks around.
const SEARCH_AFTER_FAILURES = 3;

export { readCredential };

// The settings about the box itself a new member starts with.
const MEMBER_DEFAULTS = {
  dhcp_enabled: 'false',
  backup_schedule: 'off',
  installation_complete: 'true',
};

/** An error the join screen shows as is, with a `code` it can tell apart. */
export class JoinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
  }
}

function changesPath(db, { wait = 0 } = {}) {
  const local = syncStatus(db);
  const query = new URLSearchParams({
    schema: local.schema,
    // The epoch this copy is from: the controller reads the cursor by it.
    epoch: local.epoch,
    version: APP_VERSION,
    wait,
    // Where this box answers DNS, for the list DHCP clients are given.
    addr: listenAddresses().join(','),
  });
  const cursor = readSyncState(db, 'cursor');
  if (cursor !== null && local.dataset) {
    query.set('dataset', local.dataset);
    query.set('since', cursor);
  }
  return `/api/sync/changes?${query}`;
}

// What says who this box follows, or that it was replaced as the controller.
const STANDING = ['mode', 'controller', 'fenced', 'epoch'];

/**
 * Join the controller at `address`:`port` with a join token. Everything this
 * box holds of the data of record is replaced by the controller's. Throws
 * JoinError; nothing here has changed when it does. `restart` is what runs
 * once the box is a member. A new install joins this way, and so does a
 * controller that was replaced and fenced: it stays fenced when the join
 * fails.
 */
export async function joinController(
  db,
  { address, port = 443, token },
  { restart = () => restartSoon('Joined a controller') } = {},
) {
  const parsed = parseJoinToken(token);
  if (!parsed) {
    throw new JoinError(
      'token_refused',
      'That is not a join token. Copy it again from the controller.',
    );
  }
  const controller = {
    address: String(address || '').trim(),
    port,
    fingerprint: parsed.fingerprint,
  };
  if (!controller.address) throw new JoinError('unreachable', 'Enter the controller’s address.');
  const dataDir = path.dirname(db.name);

  let joined;
  try {
    joined = await syncRequest({
      ...controller,
      method: 'POST',
      path: '/api/sync/join',
      body: {
        token: String(token).trim(),
        instance_id: ownInstanceId(db),
        name: ownInstanceName(db),
        port: getHttpsPort(),
        fingerprint: syncFingerprint(dataDir),
        version: APP_VERSION,
        schema: syncStatus(db).schema,
      },
    });
  } catch (err) {
    if (err.code === 'pin_mismatch') {
      throw new JoinError(
        'pin_mismatch',
        `${controller.address}:${port} is not the CIDRella this join token came from. ` +
          'Check the address and port, or copy the token again.',
      );
    }
    throw new JoinError('unreachable', err.message);
  }
  const answer = jsonBody(joined);
  if (joined.status !== 200 || !answer.credential) {
    throw new JoinError(
      answer.code || 'unreachable',
      answer.error || `The controller answered ${joined.status} to the join request.`,
    );
  }

  // From here the controller has this box on its list. Whatever fails, the
  // box takes itself off again and stays what it was.
  const credentialPath = path.join(syncDirOf(db), CREDENTIAL_FILE);
  const was = new Map();
  const standing = db
    .prepare(`SELECT key, value FROM sync_state WHERE key IN (${STANDING.map(() => '?')})`)
    .all(...STANDING);
  const pinned = {
    ...controller,
    // The address, port and fingerprint are the ones this box checked, never
    // ones the answer names.
    instance_id: String(answer.controller?.instance_id || ''),
    name: String(answer.controller?.name || controller.address).slice(0, 255),
  };
  try {
    // This box starts over as a copy of that controller: what it held, and
    // the epoch it was at, count for nothing there. (No epoch is sent with
    // the request either: the fencing rule is for instances of one estate.)
    db.prepare("DELETE FROM sync_state WHERE key IN ('cursor', 'epoch')").run();
    const response = await syncRequest({
      ...controller,
      path: changesPath(db),
      credential: answer.credential,
      timeoutMs: 10 * 60_000,
    });
    if (response.status !== 200) {
      const body = jsonBody(response);
      throw new JoinError(
        body.code || 'unreachable',
        body.error || `The controller answered ${response.status}.`,
      );
    }
    const changes = parseChanges(response.body);

    fs.mkdirSync(syncDirOf(db), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialPath, `${answer.credential}\n`, { mode: 0o600 });
    // A member before the data arrives: a box that dies between the two
    // comes back as a member with no cursor and takes a snapshot. What is
    // about this box alone starts from a member's defaults: it serves DNS,
    // DHCP stays off until it is moved here, it takes no backups of data it
    // does not own, and its first run is over.
    db.transaction(() => {
      // The rows as they are, a missing one as missing, to put back.
      const stored = db.prepare('SELECT value FROM settings WHERE key = ?');
      for (const key of [...Object.keys(MEMBER_DEFAULTS), SETUP_STATE_KEY]) {
        was.set(key, stored.get(key)?.value ?? null);
      }
      for (const [key, value] of Object.entries(MEMBER_DEFAULTS)) {
        upsertSettingWithConflict(db, key, value);
      }
      setSetupState(db, { done: true });
      writeSyncState(db, 'mode', MEMBER);
      writeSyncState(db, 'controller', JSON.stringify(pinned));
    })();
    applyChanges(db, changes);
    // A box that was replaced as the controller follows the new one now.
    if (fencedState(db)) setFenced(db, null);
  } catch (err) {
    // Whatever the undo itself runs into, the box still leaves the list.
    try {
      db.transaction(() => {
        db.prepare(`DELETE FROM sync_state WHERE key IN (${STANDING.map(() => '?')})`).run(
          ...STANDING,
        );
        for (const { key, value } of standing) writeSyncState(db, key, value);
        for (const [key, value] of was) {
          if (value === null) deleteSetting(db, key);
          else upsertSettingWithConflict(db, key, value);
        }
      })();
    } catch (undo) {
      console.error(`Could not undo a failed join: ${undo.message}`);
    }
    fs.rmSync(credentialPath, { force: true });
    await syncRequest({
      ...controller,
      method: 'POST',
      path: '/api/sync/leave',
      credential: answer.credential,
    }).catch(() => {});
    if (err instanceof JoinError) throw err;
    throw new JoinError('unreachable', `The first copy of the data failed: ${err.message}`);
  }
  // The accounts here are the controller's now: nobody is signed in.
  db.prepare('DELETE FROM sessions').run();
  ensureSyncTriggers(db, MEMBER);
  restart();
  return { controller: { name: pinned.name } };
}

// What the DNS proxy and the blocklists must be told when a table changes
// under them. The DNS and DHCP servers follow through the hooks applyChanges
// queues (sync/registry.js).
const proxyConfig = () => refreshProxyConfig();
const blocklist = () => loadBlocklist();
const allowlist = () => loadAllowlist();
const geoipRules = () => loadGeoipRules();
const geoipAllowlist = () => loadGeoipAllowlist();
const exemptions = () => loadFilteringOverrides();
// A list turned on here has to be downloaded here first.
const blocklistFeeds = (db) =>
  void refreshAllEnabled(db)
    .then(() => loadBlocklist())
    .catch((err) => console.warn('Blocklist refresh after sync failed:', err.message));
// Which instance serves DHCP is in the settings: this box may have just been
// given it, or lost it (services/dhcp-follow.js).
const dhcpInstance = (db) => dhcpStateChanged(db);
const RELOADS = {
  settings: [proxyConfig, blocklist, geoipRules, exemptions, dhcpInstance],
  blocklist_allowlist: [allowlist],
  blocklist_categories: [blocklistFeeds],
  geoip_rules: [geoipRules],
  geoip_ip_allowlist: [geoipAllowlist],
  filtering_exemptions: [exemptions],
};

function reloadFor(db, tables) {
  const reloads = new Set(tables.flatMap((table) => RELOADS[table] || []));
  for (const reload of reloads) {
    try {
      reload(db);
    } catch (err) {
      console.warn('Reload after sync failed:', err.message);
    }
  }
}

const OUTBOX_BATCH = 200;
// The controller reads a request body of up to 100 KB.
const OUTBOX_BYTES = 60_000;

/** Send what waits in the outbox to the controller. Returns how many it took. */
export async function sendOutbox(db) {
  if (!controllerOf(db) || !readCredential(db)) return 0;
  // The clients heard since the last flush go with this round.
  flushSeen(db);
  const forget = db.prepare('DELETE FROM sync_outbox WHERE id = ?');
  let sent = 0;
  for (;;) {
    const waiting = db
      .prepare('SELECT id, kind, payload FROM sync_outbox ORDER BY id LIMIT ?')
      .all(OUTBOX_BATCH);
    if (waiting.length === 0) return sent;
    const rows = [];
    let bytes = 0;
    for (const row of waiting) {
      bytes += row.payload.length + 64;
      if (rows.length > 0 && bytes > OUTBOX_BYTES) break;
      let payload = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        /* sent as nothing, so the controller takes it off the queue */
      }
      rows.push({ id: row.id, kind: row.kind, payload });
    }
    const response = await callController(db, {
      method: 'POST',
      path: '/api/sync/outbox',
      // This box's clock, so the controller can read the times in the rows by its own.
      body: { rows, now: Date.now() },
    });
    // One row the controller will never read: let it go, or it blocks the rest.
    if (response.status === 413 && rows.length === 1) {
      console.warn(`[sync] dropped an outbox row too large to send (${bytes} bytes)`);
      forget.run(rows[0].id);
      continue;
    }
    const taken = response.status === 200 ? jsonBody(response).taken : null;
    if (!Array.isArray(taken) || taken.length === 0) {
      throw new Error(`The controller answered ${response.status} to this member's outbox.`);
    }
    db.transaction(() => taken.forEach((id) => forget.run(id)))();
    sent += taken.length;
  }
}

let status = null;

/** { state, last_sync_at, last_error, cursor } on a member that is following, else null. */
export function memberSyncStatus(db) {
  return status && { ...status, cursor: Number(readSyncState(db, 'cursor') ?? 0) };
}

/**
 * Ask the controller once and apply what comes. Resolves 'current' when this
 * copy is at the head. Throws on anything else, with `code` 'paused' when the
 * two sides run different schemas, and 'fenced', 'not_controller' or
 * 'stale_epoch' when the instance asked is not the controller to follow.
 */
export async function syncOnce(db, { wait = 0 } = {}) {
  const response = await callController(db, {
    path: changesPath(db, { wait }),
    timeoutMs: (wait + 60) * 1000,
  });
  const lost = doubtIn(db, response);
  if (lost) {
    const err = new Error(
      lost === STALE_EPOCH
        ? 'The controller this member follows has been replaced by a newer one.'
        : jsonBody(response).error || 'The instance this member follows is not the controller.',
    );
    err.code = lost;
    throw err;
  }
  if (response.status === 204) {
    // Nothing to send means the controller read this cursor as one of its
    // own: this copy is of its epoch now.
    const epoch = answerEpoch(response);
    if (epoch !== null && epoch > lineageEpoch(db)) writeSyncState(db, 'epoch', epoch);
    return 'current';
  }
  if (response.status !== 200) {
    const body = jsonBody(response);
    const err = new Error(body.error || `The controller answered ${response.status}.`);
    err.code = body.code === 'schema_mismatch' ? 'paused' : body.code;
    throw err;
  }
  let delta = false;
  try {
    const changes = parseChanges(response.body);
    delta = !changes.header.snapshot;
    const result = applyChanges(db, changes);
    reloadFor(db, result.tables);
    if (result.snapshot) console.log(`[sync] took a snapshot: ${result.rows} rows`);
  } catch (err) {
    if (err instanceof SyncError && err.code === 'schema') err.code = 'paused';
    // What this copy holds does not line up with the controller: start over.
    // So does a delta that would not go in for any other reason: the same
    // delta would fail the same way every round, and a snapshot does not
    // depend on what is here.
    else if ((err instanceof SyncError && err.code === 'restart') || delta) {
      db.prepare("DELETE FROM sync_state WHERE key = 'cursor'").run();
    }
    throw err;
  }
  return 'current';
}

// Answers that mean "ask around now", not "try again later".
const LOST_CONTROLLER = new Set([FENCED, NOT_CONTROLLER, STALE_EPOCH, 'unknown_member']);

/**
 * Look for the controller to follow and follow it when it is another
 * instance (sync/find-controller.js). Resolves the new controller, or null.
 * The audit row waits in the outbox, which goes to the new controller.
 */
export async function followNewController(db) {
  const before = controllerOf(db);
  const found = await findController(db);
  if (!found) return null;
  recordAudit({
    db,
    action: 'instance_followed_controller',
    entityType: 'instance',
    source: 'sync',
    details: {
      from: before?.name ?? null,
      to: found.name,
      to_instance_id: found.instance_id,
      epoch: found.epoch,
    },
  });
  return found;
}

/**
 * Follow the controller until stopped. Keeps serving what it has whatever
 * happens: a controller that is away is retried, one on another version is
 * waited for, and one that has been replaced is left for the new one.
 * `onCurrent(db)` runs after every round that left this copy current; when
 * it resolves true the following ends (the box took over as the controller).
 * Returns the stop.
 */
export function startMemberSync(db, { onCurrent = null } = {}) {
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let timer = null;
  let failures = 0;
  let looking = null;
  status = { state: 'starting', last_sync_at: null, last_error: null };
  const pause = (ms) =>
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });
  // One search at a time, whoever asks for it.
  const look = () => {
    if (stopped) return Promise.resolve(null);
    looking ||= followNewController(db)
      .catch((err) => {
        console.warn(`[sync] could not look for the controller: ${err.message}`);
        return null;
      })
      .finally(() => {
        looking = null;
      });
    return looking;
  };
  const undoubt = onControllerDoubt((which) => {
    if (which === db) void look();
  });
  const searchTimer = setInterval(() => void look(), SEARCH_INTERVAL_MS);
  searchTimer.unref?.();

  (async () => {
    while (!stopped) {
      try {
        // The first request does not wait: a member that just booted wants
        // what it missed, not the controller's next change.
        await syncOnce(db, { wait: status.state === 'current' ? WAIT_SECONDS : 0 });
        await sendOutbox(db).catch((err) => console.warn(`[sync] ${err.message}`));
        if (stopped) break;
        status = { state: 'current', last_sync_at: new Date().toISOString(), last_error: null };
        retryMs = RETRY_MIN_MS;
        failures = 0;
        if (onCurrent && (await onCurrent(db))) break;
      } catch (err) {
        if (stopped) break;
        // Another version, or taken off the controller's list: neither mends itself.
        const paused = err.code === 'paused' || err.code === 'unknown_member';
        if (status.last_error !== err.message) console.warn(`[sync] ${err.message}`);
        const state = err.code === 'paused' ? 'paused' : 'offline';
        status = { ...status, state, last_error: err.message };
        failures++;
        // Replaced, or silent for a few rounds: another instance may be the
        // controller now. Found, it is asked at once.
        if (LOST_CONTROLLER.has(err.code) || failures >= SEARCH_AFTER_FAILURES) {
          if (await look()) {
            failures = 0;
            retryMs = RETRY_MIN_MS;
            status = { ...status, state: 'starting' };
            continue;
          }
        }
        await pause(paused ? PAUSED_RETRY_MS : retryMs);
        retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
      }
    }
  })();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(searchTimer);
    undoubt();
    status = null;
  };
}
