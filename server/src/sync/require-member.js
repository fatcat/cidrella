/**
 * Express middleware for what a member says to its controller: the request
 * carries the credential pairing gave it, and `req.member` is its row in
 * sync_instances. A member answering instead of a controller says so.
 */
import { getDb } from '../db/init.js';
import { memberForCredential } from '../models/sync-instance.js';
import { isMember } from './mode.js';

/** Every answer under /api/sync comes from the controller. */
export function controllerOnly(req, res, next) {
  if (!isMember()) return next();
  res
    .status(409)
    .json({ error: 'This instance is a member, not the controller.', code: 'not_controller' });
}

export function requireMember(req, res, next) {
  const header = req.headers.authorization || '';
  const member = header.startsWith('Bearer ')
    ? memberForCredential(getDb(), header.slice(7))
    : null;
  if (!member) {
    return res.status(401).json({
      error: 'This credential is not one this controller issued.',
      code: 'unknown_member',
    });
  }
  req.member = member;
  next();
}
