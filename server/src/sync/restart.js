/**
 * The exit a change of mode ends with. A box that joined a controller, took
 * over as one, handed over or was fenced runs different jobs from the ones
 * this process started, so the process ends and the service manager (systemd,
 * s6) brings it back in the new mode. The mode is in the database before
 * this is called: whenever the process comes back, it comes back right.
 */
const EXIT_DELAY_MS = 500;

/** Exit shortly, after the answer to the request that caused it has gone out. */
export function restartSoon(reason) {
  setTimeout(() => {
    console.log(`${reason}, exiting to restart`);
    process.exit(0);
  }, EXIT_DELAY_MS);
}
