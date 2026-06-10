import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isIP } from 'net';
import { execFileSync } from 'child_process';
import { getDb, audit, ensureDefaults } from '../db/init.js';
import { requireRole } from '../auth/roles.js';
import { clearJwtSecretCache } from '../auth/middleware.js';
import { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup, inspectBackup } from '../utils/backup.js';
import { reloadTlsCerts } from '../utils/cert.js';
import * as RangeType from '../models/range-type.js';
import * as Folder from '../models/folder.js';
import { seedDefaultOptions } from '../models/dhcp-option.js';
import * as OperationMaintenance from '../services/operation-maintenance.js';
import { syncServerDnsDefault } from '../utils/dhcp.js';

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

function certsDir() {
  const dir = path.join(DATA_DIR, 'certs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function validateSubjectValue(label, value, { required = false, max = 128 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (text.length > max) throw new Error(`${label} is too long`);
  // Conservative subset for OpenSSL -subj values. We call execFileSync with
  // argv, not a shell string, but OpenSSL still parses the subject string.
  // Reject separators, newlines, quotes, and other punctuation we do not need.
  if (!/^[A-Za-z0-9 .,'()_@&:+-]+$/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function validateDnsName(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  const check = name.startsWith('*.') ? name.slice(2) : name;
  if (name.length > 253) return false;
  if (!check || check.includes('..')) return false;
  return check.split('.').every(label =>
    label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/.test(label)
  );
}

function validateSanValue(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw new Error('Subject alternative names must be strings');
  const value = raw.trim();
  if (!value) return '';
  if (value.length > 253) throw new Error(`Subject alternative name is too long: ${value.slice(0, 40)}`);
  if (isIP(value)) return value;
  if (validateDnsName(value)) return value;
  throw new Error(`Invalid subject alternative name: ${value}`);
}

function normalizeSanList(sans) {
  if (!Array.isArray(sans)) throw new Error('san must be an array');
  if (sans.length > 100) throw new Error('san may contain at most 100 entries');
  const seen = new Set();
  const result = [];
  for (const raw of sans) {
    const value = validateSanValue(raw);
    if (!value) continue;
    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    result.push(value);
  }
  return result;
}

function sanConfigLine(value, index) {
  if (isIP(value)) {
    return `IP.${index} = ${value}`;
  }
  return `DNS.${index} = ${value}`;
}

function publicKeyPemFromCert(certPath) {
  return execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-pubkey'], { encoding: 'utf-8', timeout: 5000 }).trim();
}

function publicKeyPemFromKey(keyPath) {
  return execFileSync('openssl', ['pkey', '-in', keyPath, '-pubout'], { encoding: 'utf-8', timeout: 5000 }).trim();
}

function clearPendingCsrFiles(dir) {
  try { fs.unlinkSync(path.join(dir, 'pending-csr.key')); } catch {}
  try { fs.unlinkSync(path.join(dir, 'pending-csr.csr')); } catch {}
  try { fs.unlinkSync(path.join(dir, 'pending-csr.cnf')); } catch {}
}

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

  if (typeof cert !== 'string' || !cert) {
    return res.status(400).json({ error: 'cert field is required (PEM-encoded certificate)' });
  }
  if (cert.length > 128 * 1024) return res.status(400).json({ error: 'cert field is too large' });
  if (key !== undefined && key !== null && typeof key !== 'string') return res.status(400).json({ error: 'key field must be a string' });
  if (typeof key === 'string' && key.length > 128 * 1024) return res.status(400).json({ error: 'key field is too large' });

  // Validate cert. Key material goes through a private mkdtemp dir (0700,
  // unpredictable name) — never a fixed path in the shared /tmp, where
  // another local user could pre-create the file or plant a symlink and
  // capture the private key.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-cert-'));
  const tmpCert = path.join(tmpDir, 'cert.pem');
  const tmpKey = path.join(tmpDir, 'key.pem');
  const dir = certsDir();
  const pendingKeyPath = path.join(dir, 'pending-csr.key');
  const usingPendingKey = !key && fs.existsSync(pendingKeyPath);

  try {
    fs.writeFileSync(tmpCert, cert, { mode: 0o600 });
    if (key) {
      fs.writeFileSync(tmpKey, key, { mode: 0o600 });
    } else if (usingPendingKey) {
      fs.copyFileSync(pendingKeyPath, tmpKey);
    } else {
      throw new Error('Private key is required unless a pending CSR key exists');
    }

    // Validate certificate
    execFileSync('openssl', ['x509', '-in', tmpCert, '-noout'], { stdio: 'pipe', timeout: 5000 });

    // Validate key
    execFileSync('openssl', ['pkey', '-in', tmpKey, '-noout'], { stdio: 'pipe', timeout: 5000 });

    // Verify key matches cert
    if (publicKeyPemFromCert(tmpCert) !== publicKeyPemFromKey(tmpKey)) {
      throw new Error('Certificate and key do not match');
    }

    // Install
    fs.copyFileSync(tmpCert, path.join(dir, 'server.crt'));
    fs.copyFileSync(tmpKey, path.join(dir, 'server.key'));
    try { fs.chmodSync(path.join(dir, 'server.crt'), 0o600); } catch {}
    try { fs.chmodSync(path.join(dir, 'server.key'), 0o600); } catch {}
    clearPendingCsrFiles(dir);

    audit(req.user.id, 'update', 'tls_certificate', null, { source: usingPendingKey ? 'csr' : 'upload' });
    const reloaded = reloadTlsCerts();
    res.json({ ok: true, message: reloaded ? 'Certificate installed and applied.' : 'Certificate installed. Server restart required to apply.' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid certificate or key' });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// POST /api/operations/certs/csr — generate a private key and CSR for signing
router.post('/certs/csr', (req, res) => {
  const body = req.body || {};
  const {
    common_name,
    san = [],
    organization = '',
    organizational_unit = '',
    locality = '',
    state = '',
    country = '',
  } = body;

  let commonName;
  let subject;
  try {
    if (common_name === undefined || common_name === null || common_name === '') throw new Error('common_name is required');
    commonName = validateSanValue(common_name);
    if (!commonName) throw new Error('common_name is required');
    subject = {
      country: validateSubjectValue('country', country, { max: 2 }),
      state: validateSubjectValue('state', state),
      locality: validateSubjectValue('locality', locality),
      organization: validateSubjectValue('organization', organization),
      organizationalUnit: validateSubjectValue('organizational_unit', organizational_unit),
    };
    if (subject.country && !/^[A-Z]{2}$/i.test(subject.country)) throw new Error('country must be a 2-letter code');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const keyAlgorithmInput = body.key_algorithm ?? 'rsa';
  if (typeof keyAlgorithmInput !== 'string') return res.status(400).json({ error: 'key_algorithm must be rsa or ecdsa' });
  const keyAlgorithm = (keyAlgorithmInput || 'rsa').toLowerCase();
  if (!['rsa', 'ecdsa'].includes(keyAlgorithm)) return res.status(400).json({ error: 'key_algorithm must be rsa or ecdsa' });
  const keySize = body.key_size ?? 3072;
  if (keyAlgorithm === 'rsa') {
    if (!Number.isInteger(keySize)) return res.status(400).json({ error: 'key_size must be an integer' });
    if (![2048, 3072, 4096].includes(keySize)) return res.status(400).json({ error: 'key_size must be 2048, 3072, or 4096' });
  }
  const curveInput = body.curve ?? 'prime256v1';
  if (keyAlgorithm === 'ecdsa') {
    if (typeof curveInput !== 'string') return res.status(400).json({ error: 'curve must be prime256v1 or secp384r1' });
    if (!['prime256v1', 'secp384r1'].includes(curveInput)) return res.status(400).json({ error: 'curve must be prime256v1 or secp384r1' });
  }
  const curveName = curveInput || 'prime256v1';

  let sans;
  try {
    sans = normalizeSanList(san);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!sans.some(s => s.toLowerCase() === commonName.toLowerCase())) sans.unshift(commonName);

  const dir = certsDir();
  const keyPath = path.join(dir, 'pending-csr.key');
  const csrPath = path.join(dir, 'pending-csr.csr');
  // Lives next to the pending-csr key/csr in the app-owned certs dir, not
  // the shared /tmp (symlink-planting target); removed in the finally below.
  const configPath = path.join(dir, 'pending-csr.cnf');
  const subjectParts = [
    ['C', subject.country.toUpperCase()],
    ['ST', subject.state],
    ['L', subject.locality],
    ['O', subject.organization],
    ['OU', subject.organizationalUnit],
    ['CN', commonName]
  ].filter(([, v]) => v).map(([k, v]) => `/${k}=${v}`);

  const altNames = sans.map((name, idx) => sanConfigLine(name, idx + 1)).join('\n');
  const config = `
[req]
prompt = no
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = ${commonName}

[req_ext]
subjectAltName = @alt_names

[alt_names]
${altNames}
`;

  try {
    fs.writeFileSync(configPath, config);
    if (keyAlgorithm === 'ecdsa') {
      execFileSync('openssl', [
        'ecparam', '-name', curveName, '-genkey', '-noout', '-out', keyPath
      ], { stdio: 'pipe', timeout: 10000 });
      execFileSync('openssl', [
        'req', '-new', '-key', keyPath, '-out', csrPath,
        '-config', configPath, '-subj', subjectParts.join('')
      ], { stdio: 'pipe', timeout: 10000 });
    } else {
      execFileSync('openssl', [
        'req', '-new', '-newkey', `rsa:${keySize}`, '-nodes',
        '-keyout', keyPath, '-out', csrPath,
        '-config', configPath, '-subj', subjectParts.join('')
      ], { stdio: 'pipe', timeout: 15000 });
    }
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    try { fs.chmodSync(csrPath, 0o600); } catch {}
    const csr = fs.readFileSync(csrPath, 'utf-8');
    const keyInfo = keyAlgorithm === 'ecdsa'
      ? { key_algorithm: keyAlgorithm, curve: curveName }
      : { key_algorithm: keyAlgorithm, key_size: keySize };
    audit(req.user.id, 'create', 'tls_csr', null, { common_name: commonName, san: sans, ...keyInfo });
    res.status(201).json({ ok: true, csr, common_name: commonName, san: sans, ...keyInfo });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to generate CSR' });
  } finally {
    try { fs.unlinkSync(configPath); } catch {}
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
    clearPendingCsrFiles(certsDir);

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
    seedDefaultOptions(db);
    syncServerDnsDefault(db);

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
