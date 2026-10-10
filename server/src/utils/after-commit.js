/**
 * Per-request after-commit hook queue.
 *
 * Problem this solves
 * -------------------
 * Multi-step routes (subnet divide, merge, configure, bulk DNS edits) used to
 * call `regenerateConfigs(db)` / `regenerateDhcpConfigs(db)` inline, sometimes
 * 3-4× per request. Each call rewrites dnsmasq files and signals the daemon.
 * Worse, several routes simply forgot the call, leaving the on-disk config
 * out of sync with the DB until the next unrelated CRUD write happened by
 * chance.
 *
 * How it works
 * ------------
 * Middleware attaches `req.afterCommit(name)` to every request. Handlers
 * register hook NAMES (not functions) during the request. When the response
 * finishes successfully (status < 400), the queue is deduplicated and each
 * unique hook fires exactly once, in a deterministic order.
 *
 * Hooks fire AFTER res.end() so a slow regen never blocks the HTTP response.
 * Exceptions inside a hook are logged; they do not propagate (the client has
 * already received its 2xx).
 *
 * Hook names are fixed here (HOOK_ORDER; migration 065 CHECKs them too). What
 * each one runs is registered at boot with registerHookHandlers, so this
 * queue does not import the backend layer. Keep handlers idempotent so dedup
 * is safe regardless of call order.
 */

import { getDb } from '../db/init.js';
import {
  enqueueGeneration,
  listGenerations,
  markApplied,
  markApplying,
  markFailed,
} from '../models/configuration-generation.js';

// Hook name → function(db), registered by index.js (and the test helpers)
// from services/backend-apply.js HOOK_HANDLERS. All hooks must accept a db
// handle and return void.
// Ordering matters when one artifact depends on another: DHCP scope emit reads
// freshly synced reservations, so run DNS-side regen first, then DHCP. The
// resolver config (dnsmasq.conf) fires last and restarts the backend after.
//
// Note on ordering: hooks fire via queueMicrotask, AFTER res.on('finish').
// Callers that must observe the hook's effect synchronously (e.g. before a
// dnsmasq restart) MUST call the underlying function inline instead.
// queueRegen is not a synchronous-completion primitive.
const HOOK_ORDER = ['regenerate_dns', 'regenerate_dhcp', 'regenerate_dnsmasq_conf'];
const handlers = {};

/** Set what each hook runs: `{ regenerate_dns: (db) => ..., ... }`. */
export function registerHookHandlers(map) {
  for (const [name, handler] of Object.entries(map)) {
    if (!HOOK_ORDER.includes(name)) throw new Error(`Unknown afterCommit hook: ${name}`);
    if (typeof handler !== 'function') throw new Error(`afterCommit hook ${name} needs a function`);
    handlers[name] = handler;
  }
}

function assertKnownHook(name) {
  if (!HOOK_ORDER.includes(name)) throw new Error(`Unknown afterCommit hook: ${name}`);
}

// Per-hook single-flight state. Under concurrent writes to DNS/DHCP, the old
// design had each request's res.on('finish') handler race independently, so
// two overlapping regens could read conflicting snapshots of dns_records /
// dhcp_reservations and write inconsistent hosts.d files. We now serialize
// each hook: while one is running, new registrations flip `pending`, and the
// runner re-invokes itself at the end if pending was set during the run. Net
// effect: the hook runs at least once AFTER every registration, never
// concurrently, and coalesces bursts into at most one extra trailing pass.
const hookState = Object.fromEntries(
  HOOK_ORDER.map((name) => [name, { running: false, pending: false }]),
);

function fireHook(name) {
  const st = hookState[name];
  if (st.running) {
    st.pending = true;
    return;
  }
  st.running = true;
  st.pending = false;
  // Do the work synchronously, hooks are synchronous SQLite + dnsmasq calls.
  // queueMicrotask lets the res.on('finish') handler return before we start,
  // so the hook never delays flushing the HTTP response.
  queueMicrotask(() => {
    const db = getDb();
    const generation = markApplying(db, name)?.desired_generation || 0;
    try {
      // A known hook with nothing registered is a wiring bug at boot. Failing
      // the generation keeps the work pending for resumePendingRegeneration.
      if (!handlers[name]) throw new Error(`No handler registered for ${name}`);
      handlers[name](db);
      markApplied(db, name, generation);
    } catch (err) {
      markFailed(db, name, err?.message || err);
      console.error(`[afterCommit] ${name} failed:`, err?.message || err);
    } finally {
      st.running = false;
      // If a new request registered while we were running, run once more so
      // it's guaranteed visible before anyone sees the "quiet" state.
      if (st.pending) fireHook(name);
    }
  });
}

export function afterCommitMiddleware(req, res, next) {
  const queue = new Set();
  req.afterCommit = (hookName) => {
    assertKnownHook(hookName);
    queue.add(hookName);
  };

  res.on('finish', () => {
    // Successful response only. 4xx/5xx means the work the hook would reflect
    // either didn't commit or was user-rejected; don't act on it.
    if (res.statusCode >= 400 || queue.size === 0) return;
    for (const name of HOOK_ORDER) {
      if (queue.has(name)) {
        enqueueGeneration(getDb(), name);
        fireHook(name);
      }
    }
  });

  next();
}

/**
 * External entry point for out-of-request callers (lease watcher, schedulers)
 * to register a regen that shares the same single-flight state machine as
 * request hooks. Without this, an inline regen during a lease watcher callback
 * can race a request-triggered hook firing from queueMicrotask.
 */
export function queueRegen(hookName) {
  assertKnownHook(hookName);
  enqueueGeneration(getDb(), hookName);
  fireHook(hookName);
}

export function resumePendingRegeneration() {
  for (const row of listGenerations(getDb())) {
    if (
      HOOK_ORDER.includes(row.hook_name) &&
      (row.desired_generation > row.applied_generation || row.status !== 'applied')
    ) {
      fireHook(row.hook_name);
    }
  }
}
