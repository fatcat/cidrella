// releases-manifest.js
//
// Fetches, verifies, caches, and queries the signed releases.json manifest
// published alongside each CIDRella release. The manifest is the
// machine-readable view of RELEASE-NOTES.md and is the authoritative source
// for skip-upgrade reachability ("given the running version, what's the
// highest release I can jump to in one hop?").
//
// Trust model: the manifest is signed with the same primary minisign key
// as the release tarball. Verification happens by shelling out to the
// `minisign` CLI (installed by install.sh as a hard dep). The manifest is
// an ADVISORY INDEX — it tells you what's reachable, but the actual install
// gate is still the per-tarball minisign signature checked by update.sh.
// So a failure here (stale cached key, network glitch, signature mismatch)
// should not gate installs. It only degrades skip-upgrade to the legacy
// single-hop GitHub API check, and the UI is told via manifestAvailable:
// false so that silent degradation is visible.
//
// Keyring note (v0.4.12 v1): this implementation verifies against the
// primary pubkey only. The dual-key rotation composition gap flagged by
// the architect pre-implementation review is a known limitation — it
// only bites if a primary-key rotation has actually happened and the
// running host has a stale embedded pubkey. No rotation has occurred in
// project history so far. Follow-up: extend verify() to try primary,
// break-glass, and any rotation-state pubkeys in sequence. Tracked in
// PLAN.md under v0.4.12 Phase C open questions.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DATA_DIR, GITHUB_REPO } from '../config/defaults.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the primary minisign public key relative to the running code.
// The server lives at <install>/server/src/utils/releases-manifest.js, so
// the pubkey at <install>/scripts/cidrella.pub is three parents up.
const PRIMARY_PUBKEY = path.resolve(__dirname, '..', '..', '..', 'scripts', 'cidrella.pub');

const CACHE_FILE = path.join(DATA_DIR, 'releases-manifest.cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for background polls

const MANIFEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/releases.json`;
const MANIFEST_SIG_URL = `${MANIFEST_URL}.minisig`;

const FETCH_TIMEOUT_MS = 10 * 1000;

// compareSemver lives in utils/semver.js — this file used to carry a
// local copy to dodge the circular-import risk with update-checker.js,
// but the duplicate got out of sync in v0.4.15 (only update-checker's
// copy was rewritten for prerelease precedence) and caused the manifest
// path to offer v0.4.14 as a "downgrade update" on v0.4.15-pre.2 hosts.
import { compareSemver } from './semver.js';

// ─── cache ─────────────────────────────────────────────────

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.fetched_at || !parsed.manifest) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(manifest) {
  try {
    const payload = JSON.stringify({
      fetched_at: new Date().toISOString(),
      manifest,
    });
    fs.writeFileSync(CACHE_FILE, payload, 'utf8');
  } catch (err) {
    console.warn('releases-manifest: failed to write cache:', err.message);
  }
}

export function invalidateCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch {
    // best effort — next fetch will just overwrite
  }
}

function isCacheFresh(entry) {
  if (!entry || !entry.fetched_at) return false;
  const age = Date.now() - Date.parse(entry.fetched_at);
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS;
}

// ─── fetch + verify ───────────────────────────────────────

async function fetchBuffer(url, { binary = false } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': `CIDRella/releases-manifest` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return binary ? buf : buf.toString('utf8');
}

async function verifySignature(manifestBuf, sigBuf) {
  // Write both to tmpfiles and shell out to minisign -V. Using a temp
  // directory under /tmp so the files are gone by next fetch; we don't
  // cache the signature itself because successful verification is
  // sufficient to trust the parsed manifest.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-manifest-'));
  const manifestPath = path.join(tmpDir, 'releases.json');
  const sigPath = path.join(tmpDir, 'releases.json.minisig');
  try {
    fs.writeFileSync(manifestPath, manifestBuf);
    fs.writeFileSync(sigPath, sigBuf);
    try {
      await execFileAsync('minisign', ['-Vm', manifestPath, '-p', PRIMARY_PUBKEY], {
        timeout: 5000,
      });
      return true;
    } catch (err) {
      console.warn(
        'releases-manifest: signature verification failed:',
        err.stderr?.toString?.().trim() || err.message
      );
      return false;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function fetchAndVerify() {
  const [manifestText, sigText] = await Promise.all([
    fetchBuffer(MANIFEST_URL),
    fetchBuffer(MANIFEST_SIG_URL),
  ]);

  const verified = await verifySignature(Buffer.from(manifestText), Buffer.from(sigText));
  if (!verified) {
    throw new Error('manifest signature verification failed');
  }

  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(`manifest JSON parse failed: ${err.message}`);
  }

  if (parsed.schema_version !== 1) {
    throw new Error(`unsupported manifest schema_version: ${parsed.schema_version}`);
  }
  if (!Array.isArray(parsed.releases)) {
    throw new Error('manifest missing releases array');
  }

  return parsed;
}

// ─── public API ───────────────────────────────────────────

// Fetch the manifest, honoring cache unless forceFresh is set. Returns the
// parsed manifest on success, null on any failure (network, signature,
// parse). Never throws.
export async function fetchReleasesManifest({ forceFresh = false } = {}) {
  if (!forceFresh) {
    const cached = readCache();
    if (isCacheFresh(cached)) return cached.manifest;
  }
  try {
    const manifest = await fetchAndVerify();
    writeCache(manifest);
    return manifest;
  } catch (err) {
    console.warn('releases-manifest: fetch failed:', err.message);
    // On failure, fall back to any stale-but-parseable cache we might have.
    // Stale data is better than nothing for the reachability UI, and any
    // misleading claim gets corrected on the next successful fetch.
    const stale = readCache();
    if (stale) {
      console.warn('releases-manifest: using stale cached manifest as fallback');
      return stale.manifest;
    }
    return null;
  }
}

// Pure function: given the current running version and a parsed manifest,
// return the highest release X such that:
//   X.version > currentVersion
//   AND (X.min_from is null OR X.min_from <= currentVersion)
//
// Returns:
//   { target: 'x.y.z', chain: ['a.b.c', 'x.y.z'], intermediateNotes: [...] }
//   null if no update is reachable
//
// `chain` is the ordered list of hops from current to target. A direct
// one-hop jump has chain.length === 1. A multi-hop jump has chain.length > 1
// and intermediate entries are the minimum set of versions the user must
// install in sequence to reach the target. The computation is greedy: at
// each step it picks the highest version reachable from the previous one.
export function computeBestTarget(currentVersion, manifest) {
  if (!manifest || !Array.isArray(manifest.releases)) return null;
  if (!currentVersion) return null;

  // Work with ascending order — the chain algorithm is cleaner.
  const ascending = [...manifest.releases]
    .filter(r => r && r.version)
    .sort((a, b) => compareSemver(a.version, b.version));

  const newerThanCurrent = ascending.filter(
    r => compareSemver(r.version, currentVersion) > 0
  );
  if (newerThanCurrent.length === 0) return null;

  // Greedy walk: start at current, keep jumping to the highest reachable.
  const chain = [];
  const intermediateNotes = [];
  let at = currentVersion;
  const seen = new Set();
  // Bound the walk so a pathological manifest can't loop forever.
  for (let i = 0; i < ascending.length + 1; i++) {
    const reachable = ascending.filter(r => {
      if (compareSemver(r.version, at) <= 0) return false;
      if (r.min_from && compareSemver(r.min_from, at) > 0) return false;
      return true;
    });
    if (reachable.length === 0) break;
    const best = reachable[reachable.length - 1]; // highest
    if (seen.has(best.version)) break; // safety
    seen.add(best.version);
    chain.push(best.version);
    if (chain.length > 1) {
      // All chain entries except the final target are "intermediate."
      intermediateNotes.push({
        version: chain[chain.length - 2],
        anchor: findAnchor(manifest, chain[chain.length - 2]),
      });
    }
    at = best.version;
    if (at === ascending[ascending.length - 1].version) break;
  }

  if (chain.length === 0) return null;

  return {
    target: chain[chain.length - 1],
    chain,
    intermediateNotes,
  };
}

function findAnchor(manifest, version) {
  const r = manifest.releases.find(x => x.version === version);
  return r?.anchor || null;
}
