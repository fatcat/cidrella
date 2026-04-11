import fs from 'fs';

/**
 * Detect if running inside a Docker container.
 * Checks for /.dockerenv (standard Docker) and /run/s6/basedir (s6-overlay).
 */
export function isDockerEnvironment() {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/s6/basedir');
  } catch {
    return false;
  }
}
