/**
 * Refuse a write that needs a backend feature the active backend lacks.
 * Reads are never gated: rows stored while another backend was active stay
 * readable and deletable. Feature ids are in backends/features.js.
 */
import { featureReport, supports } from '../backends/index.js';

export const BACKEND_FEATURE_UNSUPPORTED = 'BACKEND_FEATURE_UNSUPPORTED';

/** Why `id` is unavailable, in words the UI shows. */
export function unsupportedMessage(id) {
  return featureReport().find((f) => f.id === id)?.reason || `${id} is not available.`;
}

/** An error to throw from a service when `id` is unsupported. */
export class BackendFeatureError extends Error {
  constructor(id) {
    super(unsupportedMessage(id));
    this.code = BACKEND_FEATURE_UNSUPPORTED;
    this.feature = id;
    this.status = 409;
  }
}

/** Throw a BackendFeatureError unless the active backend supports `id`. */
export function assertSupported(id) {
  if (!supports(id)) throw new BackendFeatureError(id);
}

/**
 * Send the 409 and return true when the active backend lacks `id`. Call it
 * only once the route knows the request needs the feature:
 *   if (wantsStats && refuseUnlessSupported(res, 'dhcp-stats')) return;
 */
export function refuseUnlessSupported(res, id) {
  if (supports(id)) return false;
  res
    .status(409)
    .json({ error: unsupportedMessage(id), code: BACKEND_FEATURE_UNSUPPORTED, feature: id });
  return true;
}
