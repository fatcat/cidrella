/**
 * Bounded samples for a minute's latency figures: a reservoir keeps an even
 * sample of however many values are offered, in fixed memory.
 */

/** The q-th quantile (0..1) of an ascending array, nearest rank. Null if empty. */
export function quantileOfSorted(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function createReservoir(size = 1000) {
  let samples = [];
  let seen = 0;
  return {
    add(value) {
      seen++;
      if (samples.length < size) {
        samples.push(value);
      } else {
        const j = Math.floor(Math.random() * seen);
        if (j < size) samples[j] = value;
      }
    },
    /** The samples, ascending, and how many values were offered; then empty. */
    drain() {
      const out = { sorted: samples.sort((a, b) => a - b), seen };
      samples = [];
      seen = 0;
      return out;
    },
  };
}
