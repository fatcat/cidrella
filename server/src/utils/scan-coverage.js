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

// The keys that mean "do scan", derived from INTERVAL_MS rather than retyped,
// so adding an interval to the map cannot leave the SQL arm behind. All keys
// are literal identifiers from the map above, so interpolating them into SQL
// below introduces no injection surface, but assert the shape anyway: this
// module builds SQL strings and a future key with a quote in it should fail
// loudly here rather than silently produce a broken predicate.
const SCANNING_INTERVAL_KEYS = Object.keys(INTERVAL_MS).filter(k => INTERVAL_MS[k] !== null);
for (const k of SCANNING_INTERVAL_KEYS) {
  if (!/^[0-9a-z]+$/.test(k)) throw new Error(`unsafe scan-interval key: ${k}`);
}

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

function scanBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

/**
 * Resolve the configured scan toggle for one IP. This intentionally mirrors
 * shouldScanIp after the subnet setting has inherited the global default.
 */
export function resolveScanningEnabled(ipOverride, subnetOverride, globalDefault) {
  const ipValue = scanBoolean(ipOverride);
  if (ipValue !== null) return ipValue;
  const subnetValue = scanBoolean(subnetOverride);
  if (subnetValue !== null) return subnetValue;
  return scanBoolean(globalDefault) ?? true;
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
 * that `shouldScanIp` applies in utils/scanner.js.
 *
 * The interval arm is an ALLOWLIST because `intervalToMs` is one. It used to be
 * a denylist, `TRIM(interval) NOT IN ('', 'off', '0')`, while the comment here
 * claimed the two mirrored each other. They did not, and the gap was silent in
 * the worst direction: any value outside the map, say '2h' or '10m' or '00',
 * made `intervalToMs` return null so the scheduler skipped the subnet forever,
 * while this predicate reported it scanner-covered so `bulkMarkStale` refused
 * to touch it. Nothing scanned those addresses and nothing was allowed to age
 * them out, so every host in the subnet stayed "online" permanently.
 * See REVIEW.md, duplicate-logic audit #5.
 *
 * `subnetAlias` is the `subnets` alias, `ipAlias` the `ip_addresses` alias.
 */
export function scannerCoveredSql(subnetAlias = 's', ipAlias = 'ip') {
  const interval = effectiveIntervalSql(subnetAlias);
  const named = SCANNING_INTERVAL_KEYS.map(k => `'${k}'`).join(', ');
  return `(
    ${subnetAlias}.status = 'allocated'
    AND ${subnetAlias}.total_addresses <= ${MAX_SCAN_SIZE}
    AND ${scanEnabledSql(subnetAlias)}
    AND ${interval} IS NOT NULL
    AND (
      TRIM(${interval}) IN (${named})
      OR (
        -- The same back-compat branch intervalToMs has: an all-digit string
        -- that parses above zero. GLOB '*[^0-9]*' is how SQLite spells "has a
        -- non-digit", which keeps '00' and '1h30m' out of this arm.
        TRIM(${interval}) != ''
        AND TRIM(${interval}) NOT GLOB '*[^0-9]*'
        AND CAST(TRIM(${interval}) AS INTEGER) > 0
      )
    )
    AND (${ipAlias}.scan_enabled IS NULL OR ${ipAlias}.scan_enabled != 0)
  )`;
}
