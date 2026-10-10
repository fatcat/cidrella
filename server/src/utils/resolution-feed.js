// The live feed behind the Resolution Map: the last few thousand filtering
// decisions, in memory only. Nothing here is persisted (a restart starts the
// map empty, which is what a live view wants), and nothing reads or resets the
// proxy's getAndReset* counters: those belong to the per-minute aggregator.
//
// One event per answered query: an 'answer' the proxy let through, a 'geoip'
// block (the answer was in a blocked country) or a 'blocklist' block (stopped
// before it was forwarded). An event's place is where GeoIP puts the answer:
// a country, plus a city point when the city table has one; both null when
// GeoIP is off or the answer had no address.
export const FEED_SIZE = 2000;
export const SUMMARY_WINDOW_MS = 60 * 1000;
const NAME_MAX = 253;

const ring = new Array(FEED_SIZE);
let seq = 0;

/** Records one decision. O(1): overwrites the oldest slot. */
export function recordResolution({ kind, name, type, destination = null }, now = Date.now()) {
  seq += 1;
  ring[seq % FEED_SIZE] = {
    seq,
    at: now,
    kind,
    name: typeof name === 'string' ? name.slice(0, NAME_MAX) : '',
    type: type || null,
    country: destination?.country || null,
    point: destination?.point || null,
  };
}

/**
 * Events newer than `since` (at most `limit`, the newest kept), the current
 * sequence number to poll from next, and the last minute counted by kind and
 * by answer country.
 */
export function resolutionSince(since = 0, { limit = 500, now = Date.now() } = {}) {
  const oldest = Math.max(1, seq - FEED_SIZE + 1);
  // A cursor past the end came from before a restart: start over.
  const after = since > seq ? 0 : since;
  const from = Math.max(oldest, after + 1, seq - limit + 1);
  const events = [];
  for (let s = from; s <= seq; s++) events.push(ring[s % FEED_SIZE]);

  const kinds = { answer: 0, geoip: 0, blocklist: 0 };
  const countries = new Map();
  for (let s = seq; s >= oldest; s--) {
    const event = ring[s % FEED_SIZE];
    if (now - event.at > SUMMARY_WINDOW_MS) break;
    kinds[event.kind] = (kinds[event.kind] || 0) + 1;
    if (event.kind === 'answer' && event.country) {
      countries.set(event.country, (countries.get(event.country) || 0) + 1);
    }
  }
  const topCountries = [...countries]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }));
  return {
    seq,
    events,
    summary: { windowMs: SUMMARY_WINDOW_MS, kinds, countries: countries.size, topCountries },
  };
}

/** Test hook: empties the feed. */
export function resetResolutionFeed() {
  ring.fill(undefined);
  seq = 0;
}
