import { getSetting, setSetting } from '../db/init.js';
import { APP_VERSION } from './version.js';
import { compareSemver } from './semver.js';
import {
  UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_DELAY_MS, GITHUB_REPO,
} from '../config/defaults.js';
import {
  fetchReleasesManifest,
  computeBestTarget,
  invalidateCache as invalidateManifestCache,
} from './releases-manifest.js';

// Re-export cache invalidation so callers outside this module (index.js
// boot path, route handlers for Check Now) don't import releases-manifest
// directly.
export { invalidateManifestCache };

// ─── manifest-first update check ─────────────────────────
//
// checkUpdateAvailability is the internal primitive. Returns:
//   {
//     version: 'x.y.z',            // highest reachable target
//     chain: ['y.y.y','x.y.z'],    // ordered hops from current to target
//     manifestAvailable: bool,     // true if result came from signed manifest
//     intermediateNotes: [...]     // anchors for intermediate releases
//   }
//
// Or null if no update is reachable. Never throws.

export async function checkUpdateAvailability({ forceFresh = false } = {}) {
  // Try the signed manifest first.
  const manifest = await fetchReleasesManifest({ forceFresh });
  if (manifest) {
    const best = computeBestTarget(APP_VERSION, manifest);
    if (best) {
      return {
        version: best.target,
        chain: best.chain,
        manifestAvailable: true,
        intermediateNotes: best.intermediateNotes,
      };
    }
    // Manifest available but no update reachable, still "manifest works"
    return { version: null, chain: [], manifestAvailable: true, intermediateNotes: [] };
  }

  // Fallback: legacy GitHub API call. One-hop only; chain length 1 if
  // anything newer exists, otherwise null. manifestAvailable: false so the
  // UI can surface the degradation.
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': `CIDRella/${APP_VERSION}`,
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    if (latestVersion && compareSemver(APP_VERSION, latestVersion) < 0) {
      return {
        version: latestVersion,
        chain: [latestVersion],
        manifestAvailable: false,
        intermediateNotes: [],
      };
    }
    return { version: null, chain: [], manifestAvailable: false, intermediateNotes: [] };
  } catch {
    return null;
  }
}

// Clear stale "update available" setting if it's no longer newer than us.
// Called from startUpdateScheduler so a fresh boot after an out-of-band
// upgrade doesn't show a stale banner until the next background check.
//
// For v0.4.12+ we also inspect the persisted update_chain: if the next-hop
// element (chain[0]) is ≤ APP_VERSION, the cached chain describes a
// mid-flight multi-hop sequence whose first hop has already been achieved.
// The stale data would cause /api/version to report the already-installed
// version as "next hop" until the background checker runs (up to 1h),
// so we flush it aggressively on boot.
export function clearStaleUpdateFlag() {
  const stored = getSetting('update_available_version') || '';
  const chainRaw = getSetting('update_chain') || '';
  let chainStale = false;
  if (chainRaw) {
    try {
      const chain = JSON.parse(chainRaw);
      if (Array.isArray(chain) && chain.length > 0) {
        if (compareSemver(chain[0], APP_VERSION) <= 0) chainStale = true;
      }
    } catch { chainStale = true; }
  }
  const targetStale = stored && compareSemver(stored, APP_VERSION) <= 0;
  if (targetStale || chainStale) {
    setSetting('update_available_version', '');
    setSetting('update_release_url', '');
    setSetting('update_chain', '');
    setSetting('update_intermediate_notes', '');
  }
}

export async function checkForUpdates({ forceFresh = false } = {}) {
  try {
    const enabled = getSetting('update_check_enabled');
    if (enabled === 'false') return null;

    const result = await checkUpdateAvailability({ forceFresh });
    setSetting('update_checked_at', new Date().toISOString());

    if (!result || !result.version) {
      setSetting('update_available_version', '');
      setSetting('update_release_url', '');
      setSetting('update_chain', '');
      setSetting('update_manifest_available', result?.manifestAvailable ? 'true' : 'false');
      return null;
    }

    // Build a GitHub release URL for the NEXT HOP (chain[0]) since
    // that's the version clicking Install will actually install. For a
    // direct one-hop jump chain[0] == result.version (the chain target),
    // so the URL is the same as the pre-v0.4.12 behavior. For a multi-hop
    // chain, the release-notes link now points at what's being installed
    // right now, not the ultimate destination.
    const nextHop = (result.chain && result.chain[0]) || result.version;
    const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/v${nextHop}`;

    setSetting('update_available_version', result.version);
    setSetting('update_release_url', releaseUrl);
    setSetting('update_chain', JSON.stringify(result.chain || []));
    setSetting('update_manifest_available', result.manifestAvailable ? 'true' : 'false');
    setSetting('update_intermediate_notes', JSON.stringify(result.intermediateNotes || []));

    const chainLabel = result.chain.length > 1
      ? ` (via ${result.chain.slice(0, -1).map(v => 'v' + v).join(' → ')})`
      : '';
    console.log(`Update available: v${APP_VERSION} → v${result.version}${chainLabel}${result.manifestAvailable ? '' : ' [fallback]'}`);
    return { version: result.version, url: releaseUrl };
  } catch (err) {
    // Network errors are expected (offline, rate-limited, etc.)
    return null;
  }
}

let timer = null;

export function startUpdateScheduler() {
  if (timer) return;

  // Clear stale flag immediately on boot, the running code may be newer
  // than whatever the DB was told about previously (e.g., manual deploy).
  clearStaleUpdateFlag();

  // Bust the manifest cache on every boot. A successful update restarts
  // the service, so this guarantees the post-update reachability view is
  // computed against a fresh manifest. It also keeps cached data from
  // outliving the 1h TTL if the host sleeps or stops cidrella for a while.
  invalidateManifestCache();

  if (UPDATE_CHECK_DELAY_MS > 0) {
    setTimeout(() => {
      checkForUpdates();
      timer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
    }, UPDATE_CHECK_DELAY_MS);
  } else {
    checkForUpdates();
    timer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  }
}
