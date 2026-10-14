/**
 * Whether a server stack switch (services/stack-switch.js) is running. Kept
 * apart so the DNS proxy and the routes can ask without importing the
 * switch and everything it imports.
 */
let switching = false;

export const switchInProgress = () => switching;

export function setSwitchInProgress(value) {
  switching = value;
}
