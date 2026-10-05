import { AsyncLocalStorage } from 'node:async_hooks';

// Who caused the current write, for records written far from the route that
// knows (address history, written in the models). Set per request after
// authentication; background work (scans, lease sync, cleanup) runs outside
// any request and so has no actor.
const storage = new AsyncLocalStorage();

export function actorMiddleware(req, _res, next) {
  storage.run({ username: req.user?.username || null }, next);
}

export function runAsActor(username, fn) {
  return storage.run({ username: username || null }, fn);
}

export function currentActor() {
  return storage.getStore()?.username || null;
}
