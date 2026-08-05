/**
 * Shared definition of "will the active scanner ever probe this address".
 *
 * Two things need to agree on this and must not drift apart:
 *   - the scheduler, which decides what to scan (utils/scan-scheduler.js)
 *   - the passive staleness sweep, which may only mark a row offline when the
 *     scanner is NOT going to disprove it (models/ip-address.js bulkMarkStale)
 *
 * If the sweep thought an address was unscanned while the scheduler kept
 * probing it, a host that answers every scan would flap offline between scans.
 * Keeping one definition here is what prevents that.
 *
 * This module deliberately imports nothing but config defaults, so both the
 * scheduler (which pulls in the scanner) and the IP model can use it without
 * creating an import cycle.
 */

import { MAX_SCAN_SIZE } from '../config/defaults.js';

const INTERVAL_MS = {
  '': null,
  'off': null,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

/**
 * Resolve a stored scan-interval value to milliseconds, or null when the
 * interval means "never scan".
 */
export function intervalToMs(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (Object.hasOwn(INTERVAL_MS, raw)) return INTERVAL_MS[raw];

  // Backward compatibility for any installs that persisted the old
  // integer-minutes shape before the UI/API contract was aligned.
  if (/^\d+$/.test(raw)) {
    const minutes = parseInt(raw, 10);
    return minutes > 0 ? minutes * 60 * 1000 : null;
  }

  return null;
}

/**
 * SQL predicate: does scanning resolve to enabled for this subnet.
 * Inheritance: subnet override, then the default_scan_enabled setting, then on.
 * `alias` is the table alias for `subnets` in the surrounding query.
 */
export function scanEnabledSql(alias = 's') {
  return `
    COALESCE(
      ${alias}.scan_enabled,
      CASE
        WHEN (SELECT value FROM settings WHERE key = 'default_scan_enabled') IN ('1', 'true') THEN 1
        WHEN (SELECT value FROM settings WHERE key = 'default_scan_enabled') IN ('0', 'false') THEN 0
        ELSE 1
      END
    ) = 1
  `;
}

/**
 * SQL expression yielding the subnet's effective scan interval, falling back to
 * the default_scan_interval setting when the subnet has no override.
 */
export function effectiveIntervalSql(alias = 's') {
  return `COALESCE(${alias}.scan_interval, (SELECT value FROM settings WHERE key = 'default_scan_interval'))`;
}

/**
 * SQL predicate: will the scheduler ever probe this address.
 *
 * Mirrors the scheduler's subnet filter plus the per-IP `scan_enabled` override
 * that `shouldScanIp` applies in utils/scanner.js. The interval arm mirrors
 * `intervalToMs` returning null: empty, 'off', and a non-positive integer all
 * mean never.
 *
 * `subnetAlias` is the `subnets` alias, `ipAlias` the `ip_addresses` alias.
 */
export function scannerCoveredSql(subnetAlias = 's', ipAlias = 'ip') {
  const interval = effectiveIntervalSql(subnetAlias);
  return `(
    ${subnetAlias}.status = 'allocated'
    AND ${subnetAlias}.total_addresses <= ${MAX_SCAN_SIZE}
    AND ${scanEnabledSql(subnetAlias)}
    AND ${interval} IS NOT NULL
    AND TRIM(${interval}) NOT IN ('', 'off', '0')
    AND (${ipAlias}.scan_enabled IS NULL OR ${ipAlias}.scan_enabled != 0)
  )`;
}
