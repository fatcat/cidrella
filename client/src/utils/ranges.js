/**
 * Analytics time-range vocabulary, in one place.
 *
 * The set of INTRADAY ranges was enumerated twice: as an inline
 * `range === '1h' || range === '4h' || range === '12h' || range === '24h'`
 * in dateFormat.js, deciding whether a chart axis shows a time or a date, and
 * implicitly again in chart-config.js's RANGE_OPTIONS (duplicate-logic audit
 * #60/#F19). Adding a range to the picker without adding it to the inline list
 * silently mislabels that chart's axis.
 *
 * A leaf module with no imports, so both dateFormat.js and chart-config.js can
 * use it without dragging chart dependencies into date formatting.
 */

/** Ranges short enough that an axis tick should read as a time, not a date. */
export const INTRADAY_RANGES = Object.freeze(['1h', '4h', '12h', '24h']);

export function isIntradayRange(range) {
  return INTRADAY_RANGES.includes(range);
}
