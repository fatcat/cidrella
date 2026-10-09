// The Resolution Map's math, kept apart from the canvas so it can be tested
// without one. Points are [lon, lat] in degrees, as d3-geo uses them.
import { COUNTRY_GEO } from './country-geo.js';

/** How far an answer with only a country lands from that country's middle. */
export const SCATTER_DEGREES = [4, 3];

// A small deterministic hash of a string to [0, 1), so the same name lands
// in the same spot each time it is answered.
function unit(text, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** A point near `at`, spread by `name`, within half of SCATTER_DEGREES each way. */
export function scatter(at, name = '') {
  const [lon, lat] = at;
  return [
    lon + (unit(name, 1) - 0.5) * SCATTER_DEGREES[0],
    Math.max(-89, Math.min(89, lat + (unit(name, 2) - 0.5) * SCATTER_DEGREES[1])),
  ];
}

/**
 * Where an event lands: its city point, else its country's middle scattered
 * by name, else nowhere (null), for a blocklist block or an unplaced answer.
 */
export function destinationOf(event) {
  if (Array.isArray(event.point)) return event.point;
  const geo = event.country && COUNTRY_GEO[event.country];
  return geo ? scatter(geo.at, event.name) : null;
}

/** The middle of the browser's locale country (en-US gives the US), or null. */
export function localeHome(languages = globalThis.navigator?.languages || []) {
  for (const tag of languages) {
    let region;
    try {
      region = new Intl.Locale(tag).maximize().region;
    } catch {
      continue;
    }
    if (region && COUNTRY_GEO[region]) return COUNTRY_GEO[region].at;
  }
  return null;
}

/** Whether a point faces the viewer on a globe turned to `rotate` ([λ, φ]). */
export function facesViewer(point, rotate, geoDistance) {
  return geoDistance(point, [-rotate[0], -rotate[1]]) < Math.PI / 2;
}

/**
 * A point along a flight at t (0..1), lifted off the surface so it reads as a
 * trajectory: up the screen on the map, out from the middle on the globe.
 * `projection` is a d3 projection, `interp` a d3.geoInterpolate(home, dest).
 */
export function liftedPoint(projection, mode, flight, t) {
  const p = projection(flight.interp(t));
  if (!p) return null;
  const lift = Math.sin(Math.PI * t);
  if (mode === 'map') {
    const a = projection(flight.home);
    const b = projection(flight.dest);
    const dist = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    return [p[0], p[1] - lift * Math.min(160, dist * 0.32)];
  }
  const [cx, cy] = projection.translate();
  const k = 1 + lift * 0.18;
  return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
}

/** How fast a flight crosses the globe, in degrees of arc a second. */
export const FLIGHT_DEGREES_PER_SECOND = 45;
const MIN_FLIGHT_SECONDS = 0.8;

/**
 * How long a flight from a to b takes: the same pace for every flight, so a
 * long one is not faster on screen, with a floor so a short hop still shows.
 */
export function flightSeconds(a, b, geoDistance = arcRadians) {
  const degrees = (geoDistance(a, b) * 180) / Math.PI;
  return Math.max(MIN_FLIGHT_SECONDS, degrees / FLIGHT_DEGREES_PER_SECOND);
}

// Great-circle distance in radians (haversine), so this module needs no d3.
function arcRadians([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether the step from a to b jumps across the flat map (a flight over the
 * date line leaves one edge and comes in at the other), so the trail breaks
 * there instead of streaking across the world.
 */
export function wrapsAround(a, b, width) {
  return Boolean(a && b) && Math.abs(b[0] - a[0]) > width / 3;
}

/**
 * When each event of one poll should launch, in ms from now: spread over
 * `spanMs` in the order and spacing the server saw them, so a poll's worth of
 * answers arrives as a stream rather than a volley.
 */
export function launchDelays(events, spanMs) {
  if (events.length === 0) return [];
  const first = events[0].at;
  const last = events[events.length - 1].at;
  const width = last - first;
  if (width <= 0) return events.map((_, i) => (i * spanMs) / events.length);
  return events.map((e) => ((e.at - first) / width) * spanMs * 0.95);
}
