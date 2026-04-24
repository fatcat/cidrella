import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { getDb, getSetting, setSetting } from '../db/init.js';
import { DATA_DIR } from '../config/defaults.js';
import { APP_VERSION } from './version.js';
import { compareSemver } from './semver.js';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PRE_RESTORE_DIR = path.join(DATA_DIR, 'snapshots', 'pre-restore');
const MANIFEST_NAME = 'cidrella-backup-manifest.json';
const MANIFEST_TYPE = 'cidrella-backup';

// Single source of truth for "files that must never ride along in a backup
// or snapshot." dnsmasq log + pid files are runtime artifacts, not state;
// including them triggered the 2026-04-21 freeze incident (1.5 GB log
// inflated every archive). Used by createBackup, restoreBackup (defense
// against legacy archives that slipped logs through), and
// takePreRestoreSnapshot. The matcher `isRuntimeArtifact` is kept in
// lockstep with the glob list so analyzeArchive's size accounting agrees
// with what tar will actually skip at extract time.
const RUNTIME_ARTIFACT_EXCLUDES = [
  '--exclude=*.log',
  '--exclude=*.log.*',
  '--exclude=*.log-*',
  '--exclude=*.pid',
];
// Defense-in-depth: explicit names for the two files known to be problematic,
// in case a future tar changes glob semantics. Appended to the base list in
// archive-producing paths (create + restore); the snapshot path doesn't need
// these because the globs above fully cover DATA_DIR/dnsmasq/.
const DEFENSIVE_EXCLUDES = [
  '--exclude=dnsmasq.log',
  '--exclude=dnsmasq.pid',
];
function isRuntimeArtifact(name) {
  return /\.log(\.|-|$)/i.test(name) || /\.pid$/i.test(name);
}

/**
 * Create a backup archive of the CIDRella data
 */
export function createBackup(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Checkpoint WAL to ensure all data is in the main DB file
  db.pragma('wal_checkpoint(TRUNCATE)');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `cidrella-backup-${timestamp}.tar.gz`;
  const archivePath = path.join(BACKUP_DIR, filename);

  // Write a manifest so restore can verify compatibility.
  // Captures version, schema version, creation time, and included files.
  const schemaVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  const manifest = {
    type: MANIFEST_TYPE,
    cidrella_version: APP_VERSION,
    schema_version: schemaVersion,
    created_at: new Date().toISOString(),
    includes: [],
  };

  // Build list of files/dirs to include (relative to DATA_DIR).
  //
  // Prior to v0.4.5 this only captured cidrella.db + certs + dnsmasq, which
  // silently lost two things on restore: (1) analytics.duckdb, which holds
  // historical DNS query metrics and perf data that aren't in cidrella.db and
  // aren't re-derivable; (2) anomaly/models/, which holds per-client ML
  // models that take ~48 hours of DNS traffic each to retrain. Both were
  // already being captured by the pre-restore snapshot code below — the
  // normal backup was just forgotten.
  const includes = [];
  if (fs.existsSync(path.join(DATA_DIR, 'cidrella.db'))) includes.push('cidrella.db');
  else if (fs.existsSync(path.join(DATA_DIR, 'ipam.db'))) includes.push('ipam.db');
  if (fs.existsSync(path.join(DATA_DIR, 'certs'))) includes.push('certs');
  if (fs.existsSync(path.join(DATA_DIR, 'dnsmasq'))) includes.push('dnsmasq');

  // analytics.duckdb + its WAL/shm sidecars. DuckDB may not have a WAL at
  // rest, so the sidecar loop is existence-gated. We don't checkpoint the
  // DuckDB WAL here — there's no equivalent pragma exposed to better-sqlite3
  // and the duckdb addon isn't loaded in this route. If the WAL exists, we
  // capture it alongside the main file so the restore side is self-consistent.
  if (fs.existsSync(path.join(DATA_DIR, 'analytics.duckdb'))) {
    includes.push('analytics.duckdb');
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name.startsWith('analytics.duckdb.') && name !== 'analytics.duckdb') {
        includes.push(name);
      }
    }
  }

  // Trained anomaly detection models. Each client's model represents 48+
  // hours of DNS training data; losing them forces a full re-learn cycle.
  if (fs.existsSync(path.join(DATA_DIR, 'anomaly'))) includes.push('anomaly');

  if (includes.length === 0) {
    throw new Error('No data files found to backup');
  }
  manifest.includes = includes.slice();

  // Stage manifest in DATA_DIR so tar picks it up as a sibling of cidrella.db.
  // Using a predictable name lets restore detect it without scanning.
  const manifestPath = path.join(DATA_DIR, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  try {
    // Use spawnSync (not execFileSync) so we can inspect the exit code
    // directly. dnsmasq.leases can mutate mid-archive when a DHCP client
    // lease rolls over during the second or two tar is running; tar
    // completes the archive but exits with status 1 ("some files
    // differ"). --warning=no-file-changed ONLY suppresses stderr —
    // despite the old comment's claim, it does NOT change the exit code,
    // so execFileSync would throw on that benign race and fail the
    // backup. The archive bytes captured are still self-consistent (tar
    // archives what it read), so exit 1 is treated as a soft warning.
    // Exit 2+ is still fatal (real tar failure).
    const result = spawnSync('tar', [
      // Strip runtime artifacts — see RUNTIME_ARTIFACT_EXCLUDES at the top
      // of this file.
      ...RUNTIME_ARTIFACT_EXCLUDES,
      ...DEFENSIVE_EXCLUDES,
      '--warning=no-file-changed',
      // IMPORTANT: must use '-czf' with a leading dash. The bare 'czf'
      // POSIX keyletter form doesn't coexist with long --exclude options
      // in GNU tar 1.35 — it errors with "You must specify one of the
      // '-Acdtrux'..." and produces no archive. This silently crippled
      // the v0.4.15-pre.1 hot-patch (the --exclude above was a no-op
      // anyway because tar never got the action flag).
      '-czf', archivePath, MANIFEST_NAME, ...includes,
    ], {
      cwd: DATA_DIR,
      timeout: 60000,
    });
    if (result.error) throw result.error;
    if (result.status === null) {
      throw new Error('tar timed out while creating backup');
    }
    if (result.status > 1) {
      const stderr = result.stderr?.toString()?.trim() || `tar exit ${result.status}`;
      throw new Error(`tar failed (exit ${result.status}): ${stderr}`);
    }
    // status 0 = clean. status 1 = at least one file changed mid-read
    // (typically dnsmasq.leases); archive is still valid, log + continue.
    if (result.status === 1) {
      console.warn('[backup] tar exited 1 (file changed during archive — expected for dnsmasq.leases); archive is valid');
    }
  } finally {
    try { fs.unlinkSync(manifestPath); } catch { /* ignore */ }
  }

  const stat = fs.statSync(archivePath);
  const result = db.prepare(
    'INSERT INTO backups (filename, size_bytes) VALUES (?, ?)'
  ).run(filename, stat.size);

  // Enforce retention
  enforceRetention(db);

  return {
    id: result.lastInsertRowid,
    filename,
    size_bytes: stat.size,
    created_at: new Date().toISOString(),
    cidrella_version: APP_VERSION,
    schema_version: schemaVersion,
  };
}

/**
 * Read the manifest from a backup archive without extracting it.
 * Returns null if the archive has no manifest (legacy backups from before
 * manifests existed — we still allow restoring them but lose the safety checks).
 */
function readBackupManifest(archivePath) {
  try {
    // Use '-xzf' with leading dash — matches the convention everywhere else
    // in this file. Bare 'xzf' works here today only because no --exclude
    // precedes it, but if one is ever added the quirk from createBackup
    // applies.
    const out = execFileSync('tar', ['-xzf', archivePath, '-O', MANIFEST_NAME], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(out.toString('utf-8'));
    if (parsed?.type !== MANIFEST_TYPE) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Hard caps on archive inspection. Both were reached by crafted inputs in
// the 2026-04-24 ship-gate trio — a 3.7 MB zip-bomb with 500 k tiny entries
// blew `tar tzvf`'s 16 MiB maxBuffer with ENOBUFS (HIGH H3), and a 12 GB
// gzipped archive timed out `tar tzf` before the 507 preflight could fire
// (MEDIUM M1). Size cap is on the ON-DISK gzipped size — below it, the
// uncompressed-size refusal (BACKUP_TOO_LARGE inside restoreBackup) still
// runs after the listing pass. Timeout scales with size so large legitimate
// backups aren't rejected; entry-count buffer is sized for ~500 k entries
// of typical verbose-listing length.
const MAX_ARCHIVE_GZIP_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GiB on-disk cap
const MAX_LISTING_BUFFER_BYTES = 64 * 1024 * 1024;       // 64 MiB of tar output
function tarListingTimeoutMs(archiveBytes) {
  // 10 s floor, +10 s per 200 MiB gzipped. Caps at 10 min to bound worst case.
  return Math.min(10 * 60 * 1000, Math.max(10_000, Math.ceil(archiveBytes / (200 * 1024 * 1024)) * 10_000));
}

/**
 * Parse `tar tzvf` output to compute the uncompressed size of an archive
 * and return a summary of entries that would be skipped at extract time
 * (log/pid files that our restore excludes). Size is used to preflight
 * whether the target host can safely stage the extract.
 *
 * tzvf output format per line:
 *   -rw-r--r-- owner/group  <bytes> <date> <time> <path>
 *
 * Returns { totalBytes, effectiveBytes, skippedBytes, entries }.
 * effectiveBytes is what actually lands on disk after --exclude filters.
 */
export function analyzeArchive(archivePath) {
  const archiveBytes = fs.statSync(archivePath).size;
  if (archiveBytes > MAX_ARCHIVE_GZIP_BYTES) {
    const err = new Error(
      `Archive is ${(archiveBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB on disk, ` +
      `larger than the ${(MAX_ARCHIVE_GZIP_BYTES / (1024 * 1024 * 1024))} GiB cap. ` +
      `Refusing to analyze — a legitimate CIDRella backup is never this large.`
    );
    err.code = 'BACKUP_TOO_LARGE';
    throw err;
  }
  let verbose;
  try {
    verbose = execFileSync('tar', ['tzvf', archivePath], {
      encoding: 'utf-8',
      timeout: tarListingTimeoutMs(archiveBytes),
      maxBuffer: MAX_LISTING_BUFFER_BYTES,
    });
  } catch (err) {
    // ENOBUFS = too many entries (zip bomb by count). ETIMEDOUT = too big
    // to list in our scaled timeout. Both collapse to the same semantic
    // refusal: the archive can't be safely processed on this host.
    if (err.code === 'ENOBUFS' || /maxBuffer/i.test(err.message || '')) {
      const e = new Error('Archive has too many entries to process safely');
      e.code = 'BACKUP_TOO_MANY_ENTRIES';
      throw e;
    }
    if (err.code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(err.message || '')) {
      const e = new Error('Archive is too large to list within the timeout budget');
      e.code = 'BACKUP_TOO_LARGE';
      throw e;
    }
    throw err;
  }

  let totalBytes = 0;
  let skippedBytes = 0;
  const entries = [];
  for (const line of verbose.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on whitespace, but the last field can contain spaces (symlinks
    // use ' -> ' but we only care about regular files here). Paths with
    // spaces are vanishingly rare in DATA_DIR so we treat them normally.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const size = parseInt(parts[2], 10);
    if (!Number.isFinite(size)) continue;
    const name = parts.slice(5).join(' ');
    totalBytes += size;
    entries.push({ name, size });
    // Mirror the tar --exclude policy (RUNTIME_ARTIFACT_EXCLUDES) via the
    // shared isRuntimeArtifact matcher so the size accounting can never
    // drift from what tar actually skips.
    if (isRuntimeArtifact(name)) skippedBytes += size;
  }
  return {
    totalBytes,
    skippedBytes,
    effectiveBytes: totalBytes - skippedBytes,
    entries,
  };
}

/**
 * Inspect a backup archive without modifying anything.
 * Returns { manifest, compatible, reason? }.
 */
export function inspectBackup(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error('Backup file not found');
  }

  // Size + entry-count preflight BEFORE running tar tzf. The previous
  // implementation had a fixed 30-s timeout + 16-MiB buffer here, which
  // made the 507 BACKUP_TOO_LARGE response unreachable for the exact
  // inputs it was designed to catch (a 12 GiB archive ETIMEDOUT at 30 s
  // before the size check in restoreBackup could fire) and let a 500 k-
  // entry zip bomb ENOBUFS into a leaky 400. Both cases now surface as
  // BACKUP_TOO_LARGE / BACKUP_TOO_MANY_ENTRIES with clean status codes.
  const archiveBytes = fs.statSync(archivePath).size;
  if (archiveBytes > MAX_ARCHIVE_GZIP_BYTES) {
    const err = new Error(
      `Backup is ${(archiveBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB on disk; ` +
      `refusing to process (cap ${MAX_ARCHIVE_GZIP_BYTES / (1024 * 1024 * 1024)} GiB).`
    );
    err.code = 'BACKUP_TOO_LARGE';
    throw err;
  }

  let listing;
  try {
    listing = execFileSync('tar', ['tzf', archivePath], {
      encoding: 'utf-8',
      timeout: tarListingTimeoutMs(archiveBytes),
      maxBuffer: MAX_LISTING_BUFFER_BYTES,
    });
  } catch (err) {
    if (err.code === 'ENOBUFS' || /maxBuffer/i.test(err.message || '')) {
      const e = new Error('Archive has too many entries to process safely');
      e.code = 'BACKUP_TOO_MANY_ENTRIES';
      throw e;
    }
    if (err.code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(err.message || '')) {
      const e = new Error('Archive is too large to list within the timeout budget');
      e.code = 'BACKUP_TOO_LARGE';
      throw e;
    }
    // Gzip/format errors are a normal bad-input case — keep them mapped to
    // 400 by the caller (operations.js). Don't convert to 5xx.
    throw err;
  }
  if (!listing.includes('cidrella.db') && !listing.includes('ipam.db')) {
    throw new Error('Invalid backup: missing database file');
  }

  // Validate that every entry resolves within DATA_DIR to prevent path traversal
  const resolvedDataDir = path.resolve(DATA_DIR);
  const entries = listing.split('\n').map(e => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const resolved = path.resolve(DATA_DIR, entry);
    if (!resolved.startsWith(resolvedDataDir + path.sep) && resolved !== resolvedDataDir) {
      throw new Error('Invalid archive: path traversal detected');
    }
  }

  const manifest = readBackupManifest(archivePath);

  // Compatibility rules:
  //   - No manifest → legacy backup, allow with a warning (caller decides)
  //   - Backup version > running code → refuse (running code can't support a newer schema)
  //   - Backup version <= running code → allow, migrations will run forward on startup
  if (!manifest) {
    return {
      manifest: null,
      compatible: true,
      warning: 'Legacy backup without manifest — version cannot be verified. Proceed with caution.',
    };
  }

  if (manifest.cidrella_version && compareSemver(manifest.cidrella_version, APP_VERSION) > 0) {
    return {
      manifest,
      compatible: false,
      reason: `Backup was created by CIDRella v${manifest.cidrella_version} which is newer than this instance (v${APP_VERSION}). Restoring would leave the database at a schema version this code cannot handle. Upgrade to at least v${manifest.cidrella_version} first, then restore.`,
    };
  }

  // Schema version sanity check (defensive — same idea as the version check)
  const db = getDb();
  const currentSchema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  if (manifest.schema_version != null && manifest.schema_version > currentSchema + 100) {
    // >100 is an absurd gap suggesting the backup is from an incompatible fork
    return {
      manifest,
      compatible: false,
      reason: `Backup schema version (${manifest.schema_version}) is wildly out of range vs current (${currentSchema}). Suspected incompatible or corrupt backup.`,
    };
  }

  return { manifest, compatible: true };
}

/**
 * Take a pre-restore snapshot to /var/lib/cidrella/snapshots/pre-restore/.
 * Unlike the pre-update snapshot, this is NOT managed by cidrella-rollback
 * — it's purely a safety net the admin can restore manually.
 */
function takePreRestoreSnapshot(db) {
  // mkdirSync fails with EACCES if the parent snapshots/ directory was
  // created earlier by update.sh running as root and never chown'd to
  // cidrella. Translate the opaque errno into a diagnostic-sufficient
  // message so the admin doesn't have to cross-reference the source tree.
  try {
    fs.mkdirSync(PRE_RESTORE_DIR, { recursive: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const parent = path.dirname(PRE_RESTORE_DIR);
      throw new Error(
        `Cannot create pre-restore snapshot at ${PRE_RESTORE_DIR}: ${err.code}. ` +
        `The snapshots/ directory is not writable by the cidrella service user. ` +
        `Fix on the host: sudo chown -R cidrella:cidrella ${parent} && sudo systemctl restart cidrella`
      );
    }
    throw err;
  }

  // Checkpoint WAL so cidrella.db is fully current
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

  // Clear anything from a previous pre-restore and start fresh
  for (const f of fs.readdirSync(PRE_RESTORE_DIR)) {
    try { fs.rmSync(path.join(PRE_RESTORE_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const dbFile = path.join(DATA_DIR, 'cidrella.db');
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, path.join(PRE_RESTORE_DIR, 'cidrella.db'));
  for (const side of ['cidrella.db-wal', 'cidrella.db-shm']) {
    const src = path.join(DATA_DIR, side);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PRE_RESTORE_DIR, side));
  }
  // DuckDB keeps a .wal sidecar for uncommitted writes. Copy the main file
  // and any sidecars so the snapshot isn't silently truncated to the last
  // checkpoint. Glob-style match on analytics.duckdb* catches .wal, .tmp, etc.
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name === 'analytics.duckdb' || name.startsWith('analytics.duckdb.')) {
      fs.copyFileSync(path.join(DATA_DIR, name), path.join(PRE_RESTORE_DIR, name));
    }
  }

  // Copy certs + dnsmasq (matching what's in a backup) so the pre-restore
  // state is a complete undo target. The dnsmasq directory contains a log
  // file (dnsmasq.log) that's typically root-owned because the systemd
  // unit starts dnsmasq as root before it drops to nobody. The cidrella
  // service user can't read it, which made `cp -a` fail with EACCES and
  // aborted the entire restore. We mirror the backup's exclude policy:
  // logs and pids are runtime artifacts, not state, so the snapshot
  // skips them. tar -c | tar -x with the same --exclude flags as
  // createBackup keeps the two paths consistent.
  for (const sub of ['certs', 'dnsmasq']) {
    const src = path.join(DATA_DIR, sub);
    if (!fs.existsSync(src)) continue;
    // Use tar pipe so excludes apply during the read pass; cp -a can't
    // skip files based on glob patterns. spawnSync wires stdout->stdin
    // between the two tars, no shell, no shell-injection surface.
    const reader = spawnSync('tar', [
      ...RUNTIME_ARTIFACT_EXCLUDES,
      '-cf', '-',
      '-C', DATA_DIR, sub,
    ]);
    if (reader.status !== 0) {
      throw new Error(`Pre-restore snapshot failed reading ${sub}: ${reader.stderr?.toString() || 'tar exit ' + reader.status}`);
    }
    const writer = spawnSync('tar', ['-xf', '-', '-C', PRE_RESTORE_DIR], {
      input: reader.stdout,
    });
    if (writer.status !== 0) {
      throw new Error(`Pre-restore snapshot failed writing ${sub}: ${writer.stderr?.toString() || 'tar exit ' + writer.status}`);
    }
  }

  const marker = {
    taken_at: new Date().toISOString(),
    cidrella_version: APP_VERSION,
  };
  fs.writeFileSync(path.join(PRE_RESTORE_DIR, 'manifest.json'), JSON.stringify(marker, null, 2));
}

/**
 * Restore from a backup archive.
 *
 * Flow:
 *  1. Inspect the archive (manifest, path traversal, version compatibility)
 *  2. Take a pre-restore snapshot to /var/lib/cidrella/snapshots/pre-restore/
 *  3. Extract into a staging dir, NOT directly over DATA_DIR — this way
 *     the running server never sees half-written files
 *  4. Atomically move the staged files into place
 *  5. Exit the process — systemd will restart with the new state
 *
 * The process exit (step 5) is what makes this safe. Without it, the
 * running server's open file descriptors would point at orphaned inodes
 * and any writes it made before restart would be silently lost.
 */
export function restoreBackup(archivePath, { allowIncompatible = false, inspection: preInspection = null } = {}) {
  // 1. Compatibility check. Reuse the caller's inspection if they already
  //    ran one (e.g., the API route inspects to audit before the restore);
  //    otherwise inspect here. Avoids a second tar parse for large backups.
  const inspection = preInspection || inspectBackup(archivePath);
  if (!inspection.compatible && !allowIncompatible) {
    const err = new Error(inspection.reason || 'Backup is not compatible with this instance');
    err.code = 'BACKUP_INCOMPATIBLE';
    err.manifest = inspection.manifest;
    throw err;
  }

  // 1a. Preflight size/space check. A runaway dnsmasq.log inside the
  //     archive (1.5 GB+ on prod before logrotate) combined with a small
  //     target (e.g. 1 GB RAM LXC) caused a full-system freeze during
  //     the 2026-04-21 incident. Refuse the restore up-front if the
  //     uncompressed payload wouldn't fit comfortably on the staging
  //     filesystem.
  //
  //     Staging goes alongside DATA_DIR, not /tmp — the default os.tmpdir()
  //     is tmpfs on many LXC distros (Debian 13 / systemd 257), which
  //     means extracting there consumes RAM instead of disk. statfs
  //     against tmpfs reports deceivingly large free space (usually 50%
  //     of host RAM, sometimes much more in nested virt). Same-filesystem
  //     staging also lets the swap loop below use rename() instead of
  //     cp -a, cutting I/O in half on the happy path. Also skip *.log
  //     and *.pid at extract time so legacy backups can't re-trigger
  //     the dnsmasq.log bloat.
  const analysis = analyzeArchive(archivePath);
  const stagingRoot = DATA_DIR;
  let stagingFree = Infinity;
  try {
    const stat = fs.statfsSync(stagingRoot);
    stagingFree = stat.bavail * stat.bsize;
  } catch { /* statfs unsupported — skip the check */ }
  const SAFETY_MARGIN = 512 * 1024 * 1024; // 512 MB headroom
  if (analysis.effectiveBytes + SAFETY_MARGIN > stagingFree) {
    const needMiB = Math.ceil(analysis.effectiveBytes / (1024 * 1024));
    const freeMiB = Math.floor(stagingFree / (1024 * 1024));
    const err = new Error(
      `Restore refused: backup would need ${needMiB} MiB of staging space under ${stagingRoot} ` +
      `but only ${freeMiB} MiB is free (512 MiB safety margin required). ` +
      `Free disk space or resize the host before retrying.`
    );
    err.code = 'BACKUP_TOO_LARGE';
    throw err;
  }

  const db = getDb();

  // 2. Pre-restore snapshot (safety net — not managed by cidrella-rollback)
  takePreRestoreSnapshot(db);

  // 3. Stage extraction to /tmp — if anything goes wrong here, DATA_DIR is untouched.
  //    --exclude=*.log --exclude=*.pid catches log/pid files that slipped
  //    into legacy backups (pre-2026-04-20) created before the create-side
  //    exclude was in place. Without this, a legacy backup carrying a
  //    multi-GB dnsmasq.log would thrash a resource-constrained host even
  //    if the size preflight barely passed.
  //
  //    Tar timeout scales with uncompressed size: a 2 GB extract on a slow
  //    LXC legitimately needs more than the old fixed 60s. Budget 30s per
  //    100 MB effective payload, floor 60s, cap 30min.
  const stagingDir = fs.mkdtempSync(path.join(DATA_DIR, '.restore-staging-'));
  const tarTimeout = Math.min(
    30 * 60 * 1000,
    Math.max(60000, Math.ceil(analysis.effectiveBytes / (100 * 1024 * 1024)) * 30000)
  );

  // Extract into staging. A failure here (corrupt archive, timeout, disk
  // space during extract) leaves DATA_DIR untouched — the service is
  // still healthy. Clean up the staging dir and surface a 500 via the
  // normal error path; do NOT process.exit() for this class of failure.
  try {
    execFileSync('tar', [
      ...RUNTIME_ARTIFACT_EXCLUDES,
      ...DEFENSIVE_EXCLUDES,
      // Use '-xzf' (with dash), not bare 'xzf'. See create-side comment
      // for why — same GNU tar parsing quirk applies here.
      '-xzf', archivePath, '-C', stagingDir,
    ], {
      stdio: 'pipe',
      timeout: tarTimeout,
    });
  } catch (extractErr) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const wrapped = new Error(
      `Restore extraction failed: ${extractErr.message}. ` +
      `No changes were applied to ${DATA_DIR}. Service continues running.`
    );
    wrapped.cause = extractErr;
    throw wrapped;
  }

  // Legacy backups (pre-cidrella rename) contain ipam.db. Rename in-place
  // in staging so the file lands at DATA_DIR/cidrella.db. Otherwise the
  // restored data would be silently ignored because CIDRella opens
  // cidrella.db on startup, not ipam.db.
  const legacyIpam = path.join(stagingDir, 'ipam.db');
  if (fs.existsSync(legacyIpam) && !fs.existsSync(path.join(stagingDir, 'cidrella.db'))) {
    fs.renameSync(legacyIpam, path.join(stagingDir, 'cidrella.db'));
  }

  // Verify the staged cidrella.db actually IS a SQLite 3 database before
  // swapping it into DATA_DIR. A 5-byte "stub\n" file named cidrella.db
  // satisfies every check up to this point (the filename-only validation
  // in inspectBackup, the path-traversal check, the manifest/compat flow
  // — legacy-backup-without-manifest is "compatible with warning"). But
  // after swap+exit, systemd restarts into SQLITE_NOTADB on the pragma
  // journal_mode call, crash-loops through StartLimitBurst, and finally
  // stops the unit. Recovery needs shell access. Magic-byte check here
  // catches this BEFORE the swap loop — any failure leaves DATA_DIR
  // untouched and returns a clean error via the throw below.
  const stagedDb = path.join(stagingDir, 'cidrella.db');
  if (fs.existsSync(stagedDb)) {
    const magic = Buffer.alloc(16);
    const fd = fs.openSync(stagedDb, 'r');
    let readLen = 0;
    try { readLen = fs.readSync(fd, magic, 0, 16, 0); } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
    if (readLen !== 16 || magic.toString('utf-8') !== 'SQLite format 3\x00') {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const err = new Error(
        `Invalid backup: staged cidrella.db is not a SQLite 3 database (magic bytes mismatch). ` +
        `${DATA_DIR} was NOT modified. Service continues running.`
      );
      err.code = 'INVALID_DATABASE_FILE';
      throw err;
    }
  }

  // 4. Swap staged files into DATA_DIR.
  //    The DB handle is kept open during this loop. better-sqlite3 still
  //    points at the original inode; Linux preserves it while the fd is
  //    held even though we unlink the path. Any in-flight SQLite writes
  //    during the loop are single-threaded with the handler, so they
  //    cannot race the file swap. The handle is closed below, immediately
  //    before we schedule the process exit.
  //
  //    If any copy step fails MID-LOOP (ENOSPC, permission, etc.), DATA_DIR
  //    is left in a partially-restored state. We MUST close the DB and
  //    exit so systemd restarts us — continuing to run with a half-swapped
  //    DATA_DIR is worse than a brief outage, and the pre-restore snapshot
  //    is the recovery path. The scope of this try/catch is deliberately
  //    narrow: only failures during the actual file swap trigger the exit,
  //    not the extract-side failures handled above.
  try {
    const stagedItems = fs.readdirSync(stagingDir).filter(name => name !== MANIFEST_NAME);

    // If we just restored a cidrella.db from a legacy backup, remove any
    // pre-existing ipam.db on disk so there's no confusing leftover state.
    if (stagedItems.includes('cidrella.db')) {
      fs.rmSync(path.join(DATA_DIR, 'ipam.db'), { force: true });
      fs.rmSync(path.join(DATA_DIR, 'ipam.db-wal'), { force: true });
      fs.rmSync(path.join(DATA_DIR, 'ipam.db-shm'), { force: true });
    }

    for (const name of stagedItems) {
      const src = path.join(stagingDir, name);
      const dst = path.join(DATA_DIR, name);

      if (fs.existsSync(dst)) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
      // SQLite WAL/SHM must not be left over from the pre-restore state or
      // SQLite will get confused about inconsistent WAL vs DB on next open.
      if (name === 'cidrella.db') {
        fs.rmSync(path.join(DATA_DIR, 'cidrella.db-wal'), { force: true });
        fs.rmSync(path.join(DATA_DIR, 'cidrella.db-shm'), { force: true });
      }
      // Prefer rename over cp -a when staging and DATA_DIR share a
      // filesystem: near-instant, zero extra I/O, no page-cache pressure.
      // Falls back to cp -a on EXDEV (different mounts). This halves the
      // data-copy load during restore, which matters a lot on the small
      // LXCs where the freeze incident happened.
      try {
        fs.renameSync(src, dst);
      } catch (renameErr) {
        if (renameErr.code !== 'EXDEV') throw renameErr;
        execFileSync('cp', ['-a', src, dst]);
      }
    }
  } catch (copyErr) {
    // Something went wrong mid-swap. DATA_DIR is partially restored. Force
    // an exit so systemd restarts us cleanly. The admin can recover from
    // /var/lib/cidrella/snapshots/pre-restore/.
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    setTimeout(() => {
      console.error('Restore failed mid-swap — exiting for restart', copyErr?.message);
      process.exit(1);
    }, 500);
    const wrapped = new Error(`Restore failed during file swap: ${copyErr.message}. Service will restart. Recover from /var/lib/cidrella/snapshots/pre-restore/ if needed.`);
    wrapped.cause = copyErr;
    throw wrapped;
  }

  // Happy path: clean up staging, close the DB handle, schedule exit.
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }

  // 5. Schedule process exit. systemd Restart=always will bring us back.
  //    We exit with code 0 after a short delay so the HTTP response can
  //    flush to the client before shutdown.
  setTimeout(() => {
    console.log('Restore complete — exiting for service restart');
    process.exit(0);
  }, 500);

  return {
    ok: true,
    message: 'Backup restored. Service is restarting...',
    manifest: inspection.manifest,
    warning: inspection.warning,
    pre_restore_snapshot: PRE_RESTORE_DIR,
  };
}

/**
 * List all backups, verifying files exist on disk
 */
export function listBackups(db) {
  const rows = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
  const result = [];

  for (const row of rows) {
    const filePath = path.join(BACKUP_DIR, row.filename);
    if (fs.existsSync(filePath)) {
      result.push(row);
    } else {
      // Clean up orphaned DB record
      db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    }
  }

  return result;
}

/**
 * Delete a backup file and its DB record
 */
export function deleteBackup(db, id) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Backup not found');

  const filePath = path.join(BACKUP_DIR, row.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  return row;
}

/**
 * Enforce backup retention limit
 */
function enforceRetention(db) {
  const maxCount = parseInt(getSetting('backup_retention_count') || '7', 10);

  const backups = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
  if (backups.length <= maxCount) return;

  const toDelete = backups.slice(maxCount);
  for (const backup of toDelete) {
    try {
      deleteBackup(db, backup.id);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Sweep abandoned restore-staging artifacts from DATA_DIR and
 * DATA_DIR/snapshots/. A process crash (OOM, SIGKILL, panic) between
 * upload/extract start and cleanup leaves these multi-GB files on disk
 * forever — which is especially likely on the resource-constrained hosts
 * the restore path is designed to defend. Called on server boot.
 *
 * Names swept:
 *   DATA_DIR/snapshots/.restore-upload-*.tar.gz   (operations.js upload stash)
 *   DATA_DIR/.restore-staging-*                    (backup.js extract dir)
 *
 * Only entries older than MAX_AGE_MS are removed to avoid racing a restore
 * started by a sibling request on boot.
 */
export function sweepStaleRestoreArtifacts() {
  const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  const targets = [
    { dir: path.join(DATA_DIR, 'snapshots'), match: /^\.restore-upload-/ },
    { dir: DATA_DIR, match: /^\.restore-staging-/ },
  ];
  let swept = 0;
  for (const { dir, match } of targets) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!match.test(name)) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs < MAX_AGE_MS) continue;
        fs.rmSync(fullPath, { recursive: true, force: true });
        swept++;
      } catch { /* ignore — next boot will retry */ }
    }
  }
  return swept;
}

/**
 * Get the backup directory path for a given backup
 */
export function getBackupPath(filename) {
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('Invalid backup filename');
  }
  return resolved;
}

/**
 * Start the backup scheduler
 */
export function startBackupScheduler() {
  const INTERVAL_MAP = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000
  };

  // Check every 15 minutes if a backup is due
  return setInterval(() => {
    try {
      const db = getDb();
      const scheduleValue = getSetting('backup_schedule');
      if (!scheduleValue || scheduleValue === 'off') return;

      const interval = INTERVAL_MAP[scheduleValue];
      if (!interval) return;

      const lastRunValue = getSetting('backup_last_run');
      const lastRunTime = lastRunValue ? new Date(lastRunValue).getTime() : 0;
      const now = Date.now();

      if (now - lastRunTime >= interval) {
        console.log(`Scheduled backup (${scheduleValue})...`);
        createBackup(db);

        // Update last run time
        setSetting('backup_last_run', new Date().toISOString());
        console.log('Scheduled backup completed');
      }
    } catch (err) {
      console.error('Scheduled backup failed:', err.message);
    }
  }, 15 * 60 * 1000);
}
