// Colors offered for a Network Range Type. The server refuses any color the
// address grid already uses for a status, or one close to it
// (server/src/utils/range-colors.js); a server test checks every swatch here
// passes that rule.
export const RANGE_COLOR_PRESETS = Object.freeze([
  '#ec4899',
  '#84cc16',
  '#0ea5e9',
  '#4d7c0f',
  '#db2777',
]);
export const NEW_RANGE_TYPE_COLOR = RANGE_COLOR_PRESETS[0];
