import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalizeIp } from './address.js';

// Who caused the current write, for records written far from the route that
// knows (address history, written in the models; audit rows, services/audit.js).
// Set per request after authentication, and carried into the work the request
// starts (after-commit hooks, daemon restarts). Background work (scans, lease
// sync, schedulers) runs outside any request and so has no actor.
const storage = new AsyncLocalStorage();

function contextOf(req) {
  const user = req.user;
  return {
    username: user?.username || null,
    userId: user?.id ?? null,
    // An API token carries token_id (auth/tokens.js); a sign-in session does not.
    origin: user ? (user.token_id ? 'api-token' : 'ui') : null,
    ip: canonicalizeIp(req.ip || '') || req.ip || null,
  };
}

export function actorMiddleware(req, _res, next) {
  storage.run(contextOf(req), next);
}

export function runAsActor(username, fn) {
  return storage.run({ username: username || null, userId: null, origin: null, ip: null }, fn);
}

export function currentActor() {
  return storage.getStore()?.username || null;
}

/** The request behind the current work: { username, userId, origin, ip }, or null. */
export function currentRequestContext() {
  return storage.getStore() || null;
}
