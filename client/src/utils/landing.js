// Where to drop someone after they sign in.
//
// Two things feed that decision. A `redirect` query means they asked for a
// specific page and got bounced to the login form on the way, so honor it.
// Otherwise fall back to wherever they were last time, which is what makes a
// session expiring feel like an interruption rather than a reset.

import { loadJson, saveJson } from './storage.js';

const LAST_VIEW_KEY = 'cidrella_last_view';

// Routes that are a means to an end, never a place to come back to. Landing on
// the login form after logging in, or on a 404, is worse than the default.
const NON_LANDING = new Set(['Login', 'ChangePassword', 'NotFound']);

/**
 * Reject anything that is not a plain in-app path.
 *
 * A `redirect` query rides through the URL bar, so it is attacker-supplied:
 * both "//evil.com" and "https://evil.com" are valid browser targets and
 * neither is ours. Requiring exactly one leading slash rules those out, and
 * resolving through the router confirms the path is a route we actually have
 * rather than a bare string we are about to navigate to.
 *
 * Returns the path when it is safe to use, null otherwise.
 */
export function safeInternalPath(router, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  // Protocol-relative ("//host") and the backslash variants browsers normalize
  // into one. Checked before resolve() because the router happily matches them.
  if (/^\/[/\\]/.test(path)) return null;
  let resolved;
  try {
    resolved = router.resolve(path);
  } catch {
    return null;
  }
  if (!resolved.matched.length) return null;
  if (NON_LANDING.has(resolved.name)) return null;
  return path;
}

/**
 * Record the page the user is on, so a later sign-in can put them back.
 *
 * Keyed by username: two people sharing a browser should not inherit each
 * other's last view, and the stored value outlives a logout.
 */
export function rememberView(username, route) {
  if (!username || !route?.name) return;
  if (NON_LANDING.has(route.name) || !route.matched?.length) return;
  saveJson(LAST_VIEW_KEY, { username, path: route.fullPath });
}

/**
 * The path to navigate to after a successful sign-in, in preference order:
 * the page they asked for, then the page they left off on, then the default.
 */
export function landingPath(router, username, redirectQuery) {
  const asked = safeInternalPath(router, redirectQuery);
  if (asked) return asked;

  const last = loadJson(LAST_VIEW_KEY, null);
  if (last && last.username === username) {
    const resumed = safeInternalPath(router, last.path);
    if (resumed) return resumed;
  }

  return '/';
}
