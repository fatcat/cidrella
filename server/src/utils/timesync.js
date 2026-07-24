/**
 * NTP / system-clock helpers for DNSSEC.
 *
 * DNSSEC signature validation checks each signature's inception/expiration
 * window, so a host with a skewed clock will SERVFAIL signed lookups. dnsmasq
 * is started with `dnssec-no-timecheck` (see dnsmasq.js) so it stays lenient
 * on timestamps at boot; once the clock is NTP-synchronized we send it one
 * SIGHUP to begin enforcing the time windows.
 *
 * All operations degrade gracefully when `timedatectl` is absent (Docker /
 * non-systemd hosts): status reports unavailable and enable/arm become no-ops.
 * They never throw into the startup path.
 */

import { execFileSync } from 'child_process';
import { getSetting } from '../db/init.js';
import { signalDnsmasq } from './dnsmasq.js';

let timecheckTimer = null;

// Read NTP enable + sync state via timedatectl. Read-only, needs no privilege.
export function getNtpStatus() {
  try {
    const out = execFileSync(
      'timedatectl',
      ['show', '-p', 'NTP', '-p', 'NTPSynchronized', '--value'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
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

// Turn on NTP if it isn't already. At runtime the `timedatectl set-ntp true`
// call is polkit-gated for the cidrella service account (49-cidrella.rules);
// install.sh enables it earlier as root. Tolerates failure / missing timedatectl.
export function ensureNtpEnabled() {
  const status = getNtpStatus();
  if (!status.available) {
    console.warn('[timesync] timedatectl unavailable, skipping NTP enable (Docker / non-systemd host?)');
    return false;
  }
  if (status.ntpEnabled) return true;
  try {
    execFileSync('timedatectl', ['set-ntp', 'true'], { stdio: 'pipe' });
    console.log('[timesync] NTP time synchronization enabled');
    return true;
  } catch (err) {
    const stderr = err?.stderr?.toString?.().trim();
    console.warn('[timesync] Failed to enable NTP:', stderr || err?.message || err);
    return false;
  }
}

function disarm() {
  if (timecheckTimer) {
    clearInterval(timecheckTimer);
    timecheckTimer = null;
  }
}

/**
 * Poll for clock sync and, once synchronized, SIGHUP dnsmasq exactly once so it
 * begins enforcing DNSSEC signature timestamps. No-op unless dnssec_enabled.
 * Self-clears on success, on dnssec disable, when timedatectl is unavailable,
 * or after maxAttempts. Idempotent, a second call while armed does nothing.
 */
export function armDnssecTimecheckWhenSynced(opts = {}) {
  const intervalMs = opts.intervalMs || 10000;
  const maxAttempts = opts.maxAttempts || 360; // ~1h at 10s
  if (timecheckTimer) return;
  if (getSetting('dnssec_enabled') !== 'true') return;

  let attempts = 0;
  let resolved = false;
  const finish = () => { resolved = true; disarm(); };

  const check = () => {
    if (resolved) return;
    attempts++;
    if (getSetting('dnssec_enabled') !== 'true') return finish();
    const { available, synchronized } = getNtpStatus();
    if (!available) return finish();
    if (synchronized) {
      try {
        signalDnsmasq();
        console.log('[timesync] Clock synchronized, signaled dnsmasq to enforce DNSSEC signature timestamps');
      } catch (err) {
        console.warn('[timesync] Failed to signal dnsmasq after NTP sync:', err?.message || err);
      }
      return finish();
    }
    if (attempts >= maxAttempts) {
      console.warn('[timesync] Gave up waiting for NTP sync, dnsmasq stays lenient on DNSSEC timestamps');
      return finish();
    }
  };

  timecheckTimer = setInterval(check, intervalMs);
  if (timecheckTimer.unref) timecheckTimer.unref();
  check(); // immediate first attempt
}

// Test/shutdown hook.
export function stopTimesync() {
  disarm();
}
