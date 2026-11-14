/**
 * The system clock's NTP state from timedatectl. Read-only, needs no
 * privilege. Apart from utils/timesync.js so a backend adapter can read it
 * without importing the backend registry back.
 */
import { execFileSync } from 'child_process';
import { runCommand } from './run-command.js';

const ARGS = ['show', '-p', 'NTP', '-p', 'NTPSynchronized', '--value'];
const UNAVAILABLE = { available: false, ntpEnabled: false, synchronized: false };

function parse(out) {
  const [ntp = '', sync = ''] = out.split('\n');
  return { available: true, ntpEnabled: ntp.trim() === 'yes', synchronized: sync.trim() === 'yes' };
}

/**
 * { available, ntpEnabled, synchronized }; available is false without
 * timedatectl. Resolves; never rejects.
 */
export async function getNtpStatus() {
  try {
    return parse((await runCommand('timedatectl', ARGS, { timeout: 5000 })).stdout);
  } catch {
    return UNAVAILABLE;
  }
}

// The same, synchronously, for the one caller that needs it inside a
// synchronous render: PowerDNS Recursor's DNSSEC mode, until the clock is
// known synchronized (BACKLOG.md, the deferred render-path commands).
export function getNtpStatusSync() {
  try {
    return parse(
      execFileSync('timedatectl', ARGS, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}
