/**
 * A member never changes the data of record (docs/REDUNDANCY-PLAN.md, section
 * 3; ADR 006). This is the server's say on that: on a member every API request
 * that is not a read is refused, unless it is listed here as one that only
 * touches this box or only reads. The same list holds for a controller that
 * has been fenced, and for one frozen while it hands over (section 7).
 *
 * Refused is the default, so a new write route needs no entry: it earns one
 * only when it writes no estate table and no estate settings key
 * (sync/registry.js). tests/unit/sync/write-gate-coverage.test.js fails on an
 * entry whose route is gone. The database triggers on a member are the second
 * line; this is the one that answers with a sentence a person can act on.
 */
import { ipv6Enabled } from '../utils/ipv6-support.js';
import { backupRefusal, MEMBER_READ_ONLY, writeRefusal } from './mode.js';
import { SETTINGS } from './registry.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export { MEMBER_READ_ONLY };

const isHostSetting = (key) => Object.hasOwn(SETTINGS, key) && SETTINGS[key] === 'host';

/**
 * What a member lets through. `path` is the route as Express sees it, mount
 * prefix included, with `:name` for a parameter; `prefix` covers everything
 * under it. `estate(req, params)` is for a route that writes this box's
 * settings and the estate's through one door: true when this request would
 * write the estate's, and then it is refused like any other.
 */
export const MEMBER_ALLOWED = [
  // Signing in and staying signed in. Sessions are this box's own, the audit
  // rows wait in sync_outbox, and the two-factor step is kept in sync_state.
  { method: 'POST', path: '/api/auth/login', reason: 'sign-in: a session on this box' },
  { method: 'POST', path: '/api/auth/login/totp', reason: 'sign-in, second step' },
  { method: 'POST', path: '/api/auth/logout', reason: 'ends a session on this box' },
  { method: 'POST', path: '/api/auth/activity', reason: 'keeps a session on this box alive' },

  // Pairing, promotion and the sync channel check their own callers.
  { method: '*', prefix: '/api/sync/', reason: 'the sync channel does its own checks' },
  { method: '*', prefix: '/api/instances/', reason: 'pairing and promotion do their own checks' },

  // This box's own setup.
  {
    method: 'PUT',
    path: '/api/interfaces/config',
    reason: 'this box: interfaces, ports, which services listen',
    // The IPv6 switch rides on the same form and belongs to the estate. The
    // form sends it with every save: unchanged, it is taken out of the
    // request so the handler does not write it; changed, the save is refused.
    estate: (req) => {
      // A member's own DHCP switch decides nothing: the controller moves DHCP
      // to a member (sync/dhcp-active.js). Switching it on here is refused so
      // nobody takes it for the way.
      if (req.body?.dhcp_enabled === true) return true;
      if (req.body?.ipv6_enabled === undefined) return false;
      if (req.body.ipv6_enabled !== ipv6Enabled()) return true;
      delete req.body.ipv6_enabled;
      return false;
    },
    // Why, when it is the DHCP switch: the generic sentence does not say.
    refusal: (req) =>
      req.body?.dhcp_enabled === true
        ? 'The controller decides which instance serves DHCP, so nothing was saved. ' +
          'Use Move DHCP here on its Instances page (Settings > System > Instances).'
        : null,
  },
  {
    method: 'PUT',
    path: '/api/settings/bulk',
    reason: 'settings kept on this box',
    estate: (req) => {
      const settings = req.body?.settings;
      if (!settings || typeof settings !== 'object') return false;
      return !Object.keys(settings).every(isHostSetting);
    },
  },
  {
    method: 'PUT',
    path: '/api/settings/:key',
    reason: 'a setting kept on this box',
    estate: (req, params) => !isHostSetting(params.key),
  },
  {
    method: 'PUT',
    path: '/api/setup/state',
    reason: 'first-run step markers of this box',
    // The password rule is the estate's and shares the endpoint.
    estate: (req) =>
      Boolean(req.body) && typeof req.body === 'object' && 'password_policy' in req.body,
  },
  {
    method: 'POST',
    path: '/api/backend-stack',
    reason: 'which DNS and DHCP servers this box runs',
  },
  { method: 'POST', path: '/api/operations/certs/upload', reason: 'this box: web certificate' },
  { method: 'POST', path: '/api/operations/certs/csr', reason: 'this box: web certificate' },
  { method: 'POST', path: '/api/operations/certs/reset', reason: 'this box: web certificate' },
  { method: 'POST', path: '/api/version/check', reason: 'this box: looks for an update' },
  { method: 'POST', path: '/api/version/install', reason: 'this box: starts its update' },
  { method: 'POST', path: '/api/version/update-dismiss', reason: 'this box: update status file' },
  { method: 'POST', path: '/api/logs/stream-token', reason: 'a ticket to read a log' },
  { method: 'POST', path: '/api/logs/clear', reason: "this box: a server's log file" },
  { method: 'POST', path: '/api/geoip/db/refresh', reason: 'this box: its copy of the GeoIP file' },
  { method: 'POST', path: '/api/geoip/stats/reset', reason: "this box: its proxy's counters" },

  // Renders what this box serves from the copy it holds. Writes no table.
  { method: 'POST', path: '/api/dns/apply', reason: 'renders this box: DNS config' },
  { method: 'POST', path: '/api/dhcp/apply', reason: 'renders this box: DHCP config' },

  // Reads with a body: tests, probes of something outside, arithmetic.
  { method: 'POST', path: '/api/dns/resolver-test', reason: 'a resolver test, kept in memory' },
  { method: 'DELETE', path: '/api/dns/resolver-test/:id', reason: 'cancels a running test' },
  { method: 'POST', path: '/api/dns/forwarders/test', reason: 'a test query' },
  { method: 'POST', path: '/api/subnets/configuration-preview', reason: 'a preview: reads only' },
  { method: 'POST', path: '/api/subnets/merge/preview', reason: 'a preview: reads only' },
  { method: 'POST', path: '/api/subnets/:id/divide/preview', reason: 'a preview: reads only' },
  { method: 'POST', path: '/api/subnets/calculate', reason: 'arithmetic' },
  { method: 'POST', path: '/api/pihole/probe', reason: 'reads a Pi-hole' },
  { method: 'POST', path: '/api/pihole/fetch', reason: 'reads a Pi-hole' },
  { method: 'POST', path: '/api/pihole/parse', reason: 'parses an upload, writes nothing' },
  // Mounted ahead of this gate today; listed so it stays a read if that moves.
  { method: 'POST', path: '/api/internal/analytics/query', reason: 'a read with a body' },
  { method: 'POST', path: '/api/dev/tracking', reason: 'dev UI tracking, a file on this box' },
  { method: 'DELETE', path: '/api/dev/tracking', reason: 'dev UI tracking, a file on this box' },
];

/**
 * The parameters of `path` when it is the route `pattern`, else null. Exact
 * and case sensitive, with no trailing slash forgiven: a spelling the list
 * does not hold is refused, which is the safe way to disagree with a router.
 */
function matchRoute(pattern, path) {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (!want[i].startsWith(':')) {
      if (want[i] !== got[i]) return null;
      continue;
    }
    if (!got[i]) return null;
    try {
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
    } catch {
      return null;
    }
  }
  return params;
}

// Refused like any other write, with a sentence of their own: where backups
// are taken and restored (sync/mode.js backupRefusal).
const BACKUP_ROUTES = new Set(['/api/operations/backup', '/api/operations/restore']);

/** Whether a member lets this request through. */
export function memberAllows(req) {
  if (READS.has(req.method)) return true;
  for (const entry of MEMBER_ALLOWED) {
    if (entry.method !== '*' && entry.method !== req.method) continue;
    if (entry.prefix) {
      if (req.path.startsWith(entry.prefix)) return true;
      continue;
    }
    const params = matchRoute(entry.path, req.path);
    if (params && !entry.estate?.(req, params)) return true;
  }
  return false;
}

/**
 * Mount after authMiddleware and actorMiddleware, ahead of every API router.
 * On a controller it does nothing, unless that controller is handing over to
 * a member: then it takes what a member takes and refuses the rest, so the
 * member it hands to has everything. A fenced controller is a member here
 * (sync/mode.js). The refusal says which of the three it is.
 */
export function memberWriteGate(req, res, next) {
  if (READS.has(req.method) || !req.path.startsWith('/api/')) return next();
  const refusal = writeRefusal();
  if (!refusal || memberAllows(req)) return next();
  if (BACKUP_ROUTES.has(req.path)) return res.status(409).json(backupRefusal());
  // A plain member may say more about a route it takes in part. A fenced or
  // handing-over controller keeps its own sentence: that is the reason then.
  const own = refusal.code === MEMBER_READ_ONLY ? routeRefusal(req) : null;
  res.status(409).json(own ? { ...refusal, error: own } : refusal);
}

// The sentence of the MEMBER_ALLOWED entry that refused `req`, if it has one.
function routeRefusal(req) {
  for (const entry of MEMBER_ALLOWED) {
    if (!entry.refusal || (entry.method !== '*' && entry.method !== req.method)) continue;
    if (matchRoute(entry.path, req.path)) return entry.refusal(req);
  }
  return null;
}
