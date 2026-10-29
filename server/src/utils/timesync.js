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

import { runCommand } from './run-command.js';
import { getSetting } from '../db/init.js';
import { getDnsBackend } from '../backends/index.js';
import { getNtpStatus } from './ntp-status.js';
import { recordAudit } from '../services/audit.js';

export { getNtpStatus };

let timecheckTimer = null;

// Turn on NTP if it isn't already. At runtime the `timedatectl set-ntp true`
// call is polkit-gated for the cidrella service account (49-cidrella.rules);
// install.sh enables it earlier as root. Tolerates failure / missing timedatectl.
export async function ensureNtpEnabled() {
  const status = await getNtpStatus();
  if (!status.available) {
    console.warn(
      '[timesync] timedatectl unavailable, skipping NTP enable (Docker / non-systemd host?)',
    );
    return false;
  }
  if (status.ntpEnabled) return true;
  try {
    await runCommand('timedatectl', ['set-ntp', 'true']);
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
// An audit row that must not stop the check when it cannot be written.
function note(row) {
  try {
    recordAudit(row);
  } catch (err) {
    console.warn('[timesync] Could not record the DNSSEC change:', err?.message || err);
  }
}

export function armDnssecTimecheckWhenSynced(opts = {}) {
  const intervalMs = opts.intervalMs || 10000;
  const maxAttempts = opts.maxAttempts || 360; // ~1h at 10s
  if (timecheckTimer) return;
  if (getSetting('dnssec_enabled') !== 'true') return;

  let attempts = 0;
  let resolved = false;
  const finish = () => {
    resolved = true;
    disarm();
  };

  let checking = false;
  const check = async () => {
    if (resolved || checking) return;
    checking = true;
    try {
      await checkOnce();
    } finally {
      checking = false;
    }
  };
  const checkOnce = async () => {
    attempts++;
    if (getSetting('dnssec_enabled') !== 'true') return finish();
    const { available, synchronized } = await getNtpStatus();
    if (resolved) return;
    if (!available) return finish();
    if (synchronized) {
      // A clock in sync at the first look changes nothing anyone waited for;
      // one that synced later ended a stretch of lenient DNSSEC.
      if (attempts > 1) {
        note({
          action: 'dnssec_timestamps_enforced',
          entityType: 'dns',
          source: 'timesync',
          details: { waited_seconds: Math.round(((attempts - 1) * intervalMs) / 1000) },
        });
      }
      try {
        await getDnsBackend().onClockSynchronized();
        console.log(
          '[timesync] Clock synchronized, signaled dnsmasq to enforce DNSSEC signature timestamps',
        );
      } catch (err) {
        console.warn('[timesync] Failed to signal dnsmasq after NTP sync:', err?.message || err);
      }
      return finish();
    }
    if (attempts >= maxAttempts) {
      note({
        action: 'dnssec_timestamps_lenient',
        entityType: 'dns',
        source: 'timesync',
        details: {
          reason: 'the clock never synchronized',
          waited_seconds: (attempts * intervalMs) / 1000,
        },
      });
      console.warn(
        '[timesync] Gave up waiting for NTP sync, dnsmasq stays lenient on DNSSEC timestamps',
      );
      return finish();
    }
  };

  timecheckTimer = setInterval(check, intervalMs);
  if (timecheckTimer.unref) timecheckTimer.unref();
  void check(); // immediate first attempt
}

// Test/shutdown hook.
export function stopTimesync() {
  disarm();
}
