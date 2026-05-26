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
 * Registry: add new hook names in HOOK_REGISTRY below. Keep them idempotent
 * so dedup is safe regardless of call order.
 */

import { getDb } from '../db/init.js';
import { regenerateConfigs as regenDnsConfigs, regenerateDnsmasqConf, restartDnsmasq } from './dnsmasq.js';
import { regenerateDhcpConfigs } from './dhcp.js';

// Hook name → function(db). All hooks must accept a db handle and return void.
// Ordering matters when one artifact depends on another: DHCP scope emit reads
// freshly synced reservations, so run DNS-side regen first, then DHCP. The
// main dnsmasq.conf regen fires last and restarts dnsmasq after.
//
// Note on ordering: hooks fire via queueMicrotask, AFTER res.on('finish').
// Callers that must observe the hook's effect synchronously (e.g. before a
// dnsmasq restart) MUST call the underlying function inline instead —
// queueRegen is not a synchronous-completion primitive.
const HOOK_REGISTRY = {
  regenerate_dns:  (db) => regenDnsConfigs(db),
  regenerate_dhcp: (db) => regenerateDhcpConfigs(db),
  regenerate_dnsmasq_conf: (db) => { regenerateDnsmasqConf(db); restartDnsmasq(); },
};

const HOOK_ORDER = ['regenerate_dns', 'regenerate_dhcp', 'regenerate_dnsmasq_conf'];

// Per-hook single-flight state. Under concurrent writes to DNS/DHCP, the old
// design had each request's res.on('finish') handler race independently —
// two overlapping regens could read conflicting snapshots of dns_records /
// dhcp_reservations and write inconsistent hosts.d files. We now serialize
// each hook: while one is running, new registrations flip `pending`, and the
// runner re-invokes itself at the end if pending was set during the run. Net
// effect: the hook runs at least once AFTER every registration, never
// concurrently, and coalesces bursts into at most one extra trailing pass.
const hookState = Object.fromEntries(
  HOOK_ORDER.map(name => [name, { running: false, pending: false }])
);

function fireHook(name) {
  const st = hookState[name];
  if (st.running) { st.pending = true; return; }
  st.running = true;
  st.pending = false;
  // Do the work synchronously — hooks are synchronous SQLite + dnsmasq calls.
  // queueMicrotask lets the res.on('finish') handler return before we start,
  // so the hook never delays flushing the HTTP response.
  queueMicrotask(() => {
    try {
      HOOK_REGISTRY[name](getDb());
    } catch (err) {
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
    if (!HOOK_REGISTRY[hookName]) {
      throw new Error(`Unknown afterCommit hook: ${hookName}`);
    }
    queue.add(hookName);
  };

  res.on('finish', () => {
    // Successful response only. 4xx/5xx means the work the hook would reflect
    // either didn't commit or was user-rejected; don't act on it.
    if (res.statusCode >= 400 || queue.size === 0) return;
    for (const name of HOOK_ORDER) {
      if (queue.has(name)) fireHook(name);
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
  if (!HOOK_REGISTRY[hookName]) {
    throw new Error(`Unknown afterCommit hook: ${hookName}`);
  }
  fireHook(hookName);
}
