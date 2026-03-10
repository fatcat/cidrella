import { getDb, getSetting } from '../db/init.js';
import { APP_VERSION } from './version.js';
import {
  UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_DELAY_MS, GITHUB_REPO,
} from '../config/defaults.js';

function setSetting(key, value) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

export async function checkForUpdates() {
  try {
    const enabled = getSetting('update_check_enabled');
    if (enabled === 'false') return null;

    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': `CIDRella/${APP_VERSION}`,
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) return null; // no releases yet
      return null;
    }

    const data = await res.json();
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    const releaseUrl = data.html_url || '';

    setSetting('update_checked_at', new Date().toISOString());

    if (latestVersion && compareSemver(APP_VERSION, latestVersion) < 0) {
      setSetting('update_available_version', latestVersion);
      setSetting('update_release_url', releaseUrl);
      console.log(`Update available: v${APP_VERSION} → v${latestVersion}`);
      return { version: latestVersion, url: releaseUrl };
    } else {
      setSetting('update_available_version', '');
      setSetting('update_release_url', '');
      return null;
    }
  } catch (err) {
    // Network errors are expected (offline, rate-limited, etc.)
    return null;
  }
}

let timer = null;

export function startUpdateScheduler() {
  if (timer) return;

  setTimeout(() => {
    checkForUpdates();
    timer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  }, UPDATE_CHECK_DELAY_MS);
}
