// The stored anomaly score is the Isolation Forest decision value: NEGATIVE
// means anomalous, and the flag boundary is 0. Production has never scored
// below about -0.35, so a full-scale ramp of 0.7 keeps real windows in the
// visible range without pinning the worst of them to the ceiling. Every
// component that draws a score goes through here, so the sign lives in one
// place.
export const SCORE_SCALE = 0.7;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 0 for any window inside the baseline, 1 at SCORE_SCALE below the boundary.
export function deviation(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return clamp(-score / SCORE_SCALE, 0, 1);
}

// The triage map scales the two sides of the flag boundary apart, because
// they are not the same length. Each device's boundary sits just under its own
// usual scores (the sensitivity setting places it), so calm windows land only
// a little above 0: production tops out near +0.25. Flagged windows fall
// further, to about -0.35. One shared scale of SCORE_SCALE squeezed every calm
// device into the strip just left of center.
export const MAP_CALM_SCALE = 0.25;
export const MAP_FLAGGED_SCALE = 0.35;

// Horizontal position on the triage map, 0..100. The flag boundary sits on
// the middle gridline; the right half is flagged, the left half is calm.
export function mapX(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 50;
  if (score >= 0) return 50 - 50 * clamp(score / MAP_CALM_SCALE, 0, 1);
  return 50 + 50 * clamp(-score / MAP_FLAGGED_SCALE, 0, 1);
}

// The more anomalous of two scores, for buckets that hold several windows.
export function worst(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

// Share of `all` that is calmer than `mine`: a higher score is less anomalous.
export function moreAnomalousThan(mine, all) {
  if (!all.length) return 0;
  return all.filter((s) => s > mine).length / all.length;
}
