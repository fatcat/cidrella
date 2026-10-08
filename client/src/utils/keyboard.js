// The platform's shortcut modifier: Command on a Mac, Ctrl everywhere else.
// userAgentData is the current API; navigator.platform is the fallback that
// every browser still fills in.

function platformName() {
  const nav = globalThis.navigator;
  return nav?.userAgentData?.platform || nav?.platform || '';
}

export const IS_MAC = /mac|iphone|ipad/i.test(platformName());

/** The label a shortcut hint shows for the modifier, e.g. `${MOD_LABEL} K`. */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/** Is the platform modifier, and only it, held for this key event? */
export function isModShortcut(event, key) {
  const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key;
}
