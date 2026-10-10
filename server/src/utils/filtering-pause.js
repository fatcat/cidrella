/**
 * How long filtering can be paused for, in minutes. The pause route
 * (routes/blocklists.js) accepts these and 0 to resume; the Filtering page
 * offers them through @shared. No imports: the client bundles this file.
 */
export const PAUSE_MINUTES = Object.freeze([5, 15, 30, 60]);
