import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { getDb, audit, ensureDefaults } from '../db/init.js';
import { requireRole } from '../auth/roles.js';
import { clearJwtSecretCache } from '../auth/middleware.js';
import { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup, inspectBackup } from '../utils/backup.js';
import { reloadTlsCerts } from '../utils/cert.js';
import * as RangeType from '../models/range-type.js';
import * as Folder from '../models/folder.js';
import * as OperationMaintenance from '../services/operation-maintenance.js';

import { DATA_DIR } from '../config/defaults.js';

// Error codes set by our own throw sites in utils/backup.js. Node.js system
// errors (ENOENT, EACCES, EPERM, etc.) also have a `.code` property, so a
// truthy-check would let those through and leak staging paths in the 400
// body. Matching against this set is the sanitization gate.
const APP_ERROR_CODES = new Set([
  'BACKUP_INCOMPATIBLE',
  'BACKUP_TOO_LARGE',
  'BACKUP_TOO_MANY_ENTRIES',
  'INVALID_DATABASE_FILE',
]);

const router = Router();

// All operations routes require admin
router.use(requireRole('admin'));

// POST /api/operations/backup — create a new backup
router.post('/backup', (req, res) => {
  try {
    const db = getDb();
    const backup = createBackup(db);
    audit(req.user.id, 'create', 'backup', backup.id, { filename: backup.filename });
    res.status(201).json(backup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/operations/backups — list all backups
router.get('/backups', (req, res) => {
  const db = getDb();
  res.json(listBackups(db));
});

// GET /api/operations/backups/:id/download — download a backup file
router.get('/backups/:id/download', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Backup not found' });

  const filePath = getBackupPath(row.filename);

  // Validate the resolved path is within the backup directory
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!path.resolve(filePath).startsWith(path.resolve(backupDir) + path.sep)) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup file missing from disk' });
  }

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/operations/backups/:id — delete a backup
router.delete('/backups/:id', (req, res) => {
  try {
    const db = getDb();
    const deleted = deleteBackup(db, parseInt(req.params.id, 10));
    audit(req.user.id, 'delete', 'backup', deleted.id, { filename: deleted.filename });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Backup not found' ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/operations/restore — restore from uploaded backup
// Query params:
//   ?inspect=1           — just return the manifest + compatibility, don't restore
//   ?allowIncompatible=1 — bypass version safety check (admin escape hatch)
router.post('/restore', (req, res) => {
  const contentType = req.headers['content-type'] || '';
  const inspectOnly = req.query.inspect === '1' || req.query.inspect === 'true';
  const allowIncompatible = req.query.allowIncompatible === '1' || req.query.allowIncompatible === 'true';

  if (!contentType.includes('application/gzip') && !contentType.includes('application/octet-stream')) {
    return res.status(400).json({ error: 'Content-Type must be application/gzip or application/octet-stream' });
  }

  // Stage the upload next to DATA_DIR instead of /tmp. On LXCs with
  // systemd 257+ (Debian 13), /tmp is tmpfs (RAM-backed), so uploading a
  // multi-GB backup would consume RAM before the preflight size check can
  // reject it. Writing under DATA_DIR uses the real disk and keeps the
  // preflight's statfs estimate honest.
  const uploadStagingDir = path.join(DATA_DIR, 'snapshots');
  try { fs.mkdirSync(uploadStagingDir, { recursive: true }); } catch { /* handled below if it fails */ }
  const tmpPath = path.join(uploadStagingDir, `.restore-upload-${Date.now()}.tar.gz`);
  const writeStream = fs.createWriteStream(tmpPath);
  req.pipe(writeStream);

  writeStream.on('finish', () => {
    try {
      if (inspectOnly) {
        const info = inspectBackup(tmpPath);
        fs.unlinkSync(tmpPath);
        return res.json(info);
      }

      // Check compatibility FIRST — if we bail here we don't want an
      // audit entry for a restore that never happened.
      const inspection = inspectBackup(tmpPath);
      if (!inspection.compatible && !allowIncompatible) {
        fs.unlinkSync(tmpPath);
        const err = new Error(inspection.reason || 'Backup is not compatible with this instance');
        err.code = 'BACKUP_INCOMPATIBLE';
        err.manifest = inspection.manifest;
        throw err;
      }

      // Audit BEFORE restoreBackup closes the DB handle. If we called
      // audit() after, it would hit a closed connection and throw.
      audit(req.user.id, 'restore', 'backup', null, {
        manifest: inspection.manifest,
      });

      // Send response BEFORE restoreBackup exits the process, so the client
      // sees a successful acknowledgement. The restore path spins a 500ms
      // timer before exit specifically so Express can flush the response.
      // Pass the inspection through so restoreBackup doesn't re-parse the tarball.
      const result = restoreBackup(tmpPath, { allowIncompatible, inspection });
      // Clean up the uploaded tarball — we're about to exit, but be explicit
      // so a second restore within RestartSec doesn't find a stale tmp copy.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      res.json(result);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      let status = 400;
      if (err.code === 'BACKUP_INCOMPATIBLE') status = 409;
      else if (err.code === 'BACKUP_TOO_LARGE') status = 507;
      else if (err.code === 'BACKUP_TOO_MANY_ENTRIES') status = 413;
      else if (err.code === 'INVALID_DATABASE_FILE') status = 400;
      // Sanitize the response body — subprocess errors from tar/gzip AND
      // Node system errors (ENOENT/EACCES/EPERM) include absolute staging
      // paths. 5xx is already collapsed by the global handler; 4xx bypass
      // it. Surface messages only for our own application error codes; OS
      // and third-party errors collapse to a generic message. The
      // machine-readable `code` field stays so clients can still branch.
      const isAppCode = APP_ERROR_CODES.has(err.code);
      const message = isAppCode ? err.message : 'Failed to process uploaded archive';
      res.status(status).json({ error: message, code: isAppCode ? err.code : undefined, manifest: err.manifest });
    }
  });

  writeStream.on('error', () => {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: 'Failed to save uploaded file' });
  });
});

// GET /api/operations/certs/info — get current certificate info
router.get('/certs/info', (req, res) => {
  const certPath = path.join(DATA_DIR, 'certs', 'server.crt');

  if (!fs.existsSync(certPath)) {
    return res.json({ exists: false });
  }

  try {
    const output = execFileSync(
      'openssl', ['x509', '-in', certPath, '-noout', '-subject', '-issuer', '-dates', '-fingerprint', '-sha256'],
      { encoding: 'utf-8', timeout: 5000 }
    );

    const info = {};
    for (const line of output.trim().split('\n')) {
      const [key, ...rest] = line.split('=');
      const trimKey = key.trim().toLowerCase().replace(/ /g, '_');
      info[trimKey] = rest.join('=').trim();
    }

    // Check if self-signed (subject === issuer)
    info.self_signed = (info.subject || '') === (info.issuer || '');
    info.exists = true;

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read certificate info' });
  }
});

// POST /api/operations/certs/upload — upload custom TLS cert + key
router.post('/certs/upload', (req, res) => {
  const { key, cert } = req.body;

  if (!key || !cert) {
    return res.status(400).json({ error: 'Both key and cert fields are required (PEM-encoded strings)' });
  }

  // Validate cert
  const tmpCert = path.join(os.tmpdir(), `cidrella-cert-${Date.now()}.pem`);
  const tmpKey = path.join(os.tmpdir(), `cidrella-key-${Date.now()}.pem`);

  try {
    fs.writeFileSync(tmpCert, cert);
    fs.writeFileSync(tmpKey, key);

    // Validate certificate
    execFileSync('openssl', ['x509', '-in', tmpCert, '-noout'], { stdio: 'pipe', timeout: 5000 });

    // Validate key
    execFileSync('openssl', ['pkey', '-in', tmpKey, '-noout'], { stdio: 'pipe', timeout: 5000 });

    // Verify key matches cert
    const certModulus = execFileSync('openssl', ['x509', '-in', tmpCert, '-noout', '-modulus'], { encoding: 'utf-8', timeout: 5000 }).trim();
    let keyModulus;
    try {
      keyModulus = execFileSync('openssl', ['rsa', '-in', tmpKey, '-noout', '-modulus'], { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
      keyModulus = execFileSync('openssl', ['pkey', '-in', tmpKey, '-noout', '-text'], { encoding: 'utf-8', timeout: 5000 }).trim();
    }

    // For RSA keys, modulus should match
    if (certModulus.startsWith('Modulus=') && keyModulus.startsWith('Modulus=') && certModulus !== keyModulus) {
      throw new Error('Certificate and key do not match');
    }

    // Install
    const certsDir = path.join(DATA_DIR, 'certs');
    fs.copyFileSync(tmpCert, path.join(certsDir, 'server.crt'));
    fs.copyFileSync(tmpKey, path.join(certsDir, 'server.key'));

    audit(req.user.id, 'update', 'tls_certificate', null, {});
    const reloaded = reloadTlsCerts();
    res.json({ ok: true, message: reloaded ? 'Certificate installed and applied.' : 'Certificate installed. Server restart required to apply.' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid certificate or key' });
  } finally {
    try { fs.unlinkSync(tmpCert); } catch {}
    try { fs.unlinkSync(tmpKey); } catch {}
  }
});

// POST /api/operations/certs/reset — reset to self-signed
router.post('/certs/reset', (req, res) => {
  const certsDir = path.join(DATA_DIR, 'certs');
  const keyPath = path.join(certsDir, 'server.key');
  const certPath = path.join(certsDir, 'server.crt');

  try {
    // Remove existing certs
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    if (fs.existsSync(certPath)) fs.unlinkSync(certPath);

    // Regenerate self-signed
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '365', '-nodes', '-subj', '/CN=cidrella/O=CIDRella/C=US'
    ], { stdio: 'pipe', timeout: 10000 });

    audit(req.user.id, 'update', 'tls_certificate', null, { action: 'reset_self_signed' });
    const reloaded = reloadTlsCerts();
    res.json({ ok: true, message: reloaded ? 'Self-signed certificate regenerated and applied.' : 'Self-signed certificate regenerated. Server restart required to apply.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operations/reset-database — wipe all data and reinitialize
router.post('/reset-database', async (req, res) => {
  try {
    const db = getDb();

    // Get all user-created tables (exclude schema_version and sqlite internals)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'"
    ).all().map(r => r.name);

    // Delete all data from every table
    OperationMaintenance.deleteAllTableData(db, tables);

    // Re-seed system range types
    RangeType.seedSystemRangeTypes(db);

    // Re-seed default folder
    Folder.seedDefaultFolder(db);

    // Re-run ensureDefaults to recreate admin user, JWT secret, and default settings
    await ensureDefaults();

    // `ensureDefaults` wrote a fresh jwt_secret to settings, but the auth
    // middleware holds the OLD secret in a module-level cache populated on
    // first request. Without this call, post-reset logins sign with the
    // new secret but verify against the stale cached one → every new
    // token fails with "Invalid token" until the process restarts. Trio
    // finding M3 (2026-04-24): the admin locks themselves out of their
    // own UI immediately after hitting Reset Database.
    clearJwtSecretCache();

    res.json({ ok: true, message: 'Database reset complete.' });
  } catch (err) {
    console.error('Database reset failed:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
