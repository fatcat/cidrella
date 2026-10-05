// Colors a Network Range Type may not use. The address grid already gives
// these a meaning (system, gateway, DHCP, static DNS, reservations, rogue,
// infrastructure), so a range wearing one would read as that status. A
// color is also refused when it is close to one of them or too gray to tell
// from the plain cells.

export const RESERVED_RANGE_COLORS = [
  { color: '#6b7280', label: 'system and unassigned addresses' },
  { color: '#f59e0b', label: 'gateway and static DNS' },
  { color: '#8b5cf6', label: 'reservations' },
  { color: '#ef4444', label: 'rogue hosts' },
  { color: '#22d3ee', label: 'infrastructure' },
  { color: '#3b82f6', label: 'DHCP' },
  { color: '#10b981', label: 'static addresses' },
];

// CIE76 distance in Lab. Around 2.3 is a just-noticeable difference; at this
// distance two colors still read as the same family on a small grid cell.
export const MIN_COLOR_DISTANCE = 30;
// Below this chroma a color is a gray, whatever its lightness.
export const MIN_COLOR_CHROMA = 14;
// Two saturated colors this close in hue read as one color, however far apart
// their lightness (pure red beside the rogue red).
export const MIN_HUE_DISTANCE = 28;
const SATURATED_CHROMA = 30;

function toLab(hex) {
  let digits = hex.slice(1);
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const linear = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = linear;
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function chroma(lab) {
  return Math.hypot(lab[1], lab[2]);
}

function hueDistance(a, b) {
  const gap = Math.abs((Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) * (180 / Math.PI));
  return gap > 180 ? 360 - gap : gap;
}

/**
 * Why a hex color cannot name a Network Range, or null when it can.
 * `hex` is already validated as #RGB or #RRGGBB.
 */
export function rangeColorProblem(hex) {
  const lab = toLab(hex);
  if (chroma(lab) < MIN_COLOR_CHROMA) {
    return 'is too gray to tell from an unassigned or system address';
  }
  for (const reserved of RESERVED_RANGE_COLORS) {
    const other = toLab(reserved.color);
    const sameHue =
      chroma(lab) >= SATURATED_CHROMA &&
      chroma(other) >= SATURATED_CHROMA &&
      hueDistance(lab, other) < MIN_HUE_DISTANCE;
    if (sameHue || distance(lab, other) < MIN_COLOR_DISTANCE) {
      return `is too close to ${reserved.color}, which marks ${reserved.label} in the address grid`;
    }
  }
  return null;
}
