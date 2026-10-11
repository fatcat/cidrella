/**
 * The system clock's NTP state from timedatectl. Read-only, needs no
 * privilege. Apart from utils/timesync.js so a backend adapter can read it
 * without importing the backend registry back.
 */
import { execFileSync } from 'child_process';

/** { available, ntpEnabled, synchronized }; available is false without timedatectl. */
export function getNtpStatus() {
  try {
    const out = execFileSync(
      'timedatectl',
      ['show', '-p', 'NTP', '-p', 'NTPSynchronized', '--value'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [ntp = '', sync = ''] = out.split('\n');
    return {
      available: true,
      ntpEnabled: ntp.trim() === 'yes',
      synchronized: sync.trim() === 'yes',
    };
  } catch {
    return { available: false, ntpEnabled: false, synchronized: false };
  }
}
