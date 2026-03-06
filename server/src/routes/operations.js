import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getDb, audit } from '../db/init.js';
import { requireRole } from '../auth/roles.js';
import { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup } from '../utils/backup.js';

const router = Router();
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');

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
router.post('/restore', (req, res) => {
  const contentType = req.headers['content-type'] || '';

  // Accept raw tar.gz upload
  if (!contentType.includes('application/gzip') && !contentType.includes('application/octet-stream')) {
    return res.status(400).json({ error: 'Content-Type must be application/gzip or application/octet-stream' });
  }

  const tmpPath = path.join(os.tmpdir(), `ipam-restore-${Date.now()}.tar.gz`);

  const writeStream = fs.createWriteStream(tmpPath);
  req.pipe(writeStream);

  writeStream.on('finish', () => {
    try {
      const result = restoreBackup(tmpPath);
      fs.unlinkSync(tmpPath);
      audit(req.user.id, 'restore', 'backup', null, {});
      res.json(result);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      res.status(400).json({ error: err.message });
    }
  });

  writeStream.on('error', (err) => {
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
    const output = execSync(
      `openssl x509 -in "${certPath}" -noout -subject -issuer -dates -fingerprint -sha256`,
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
  const tmpCert = path.join(os.tmpdir(), `ipam-cert-${Date.now()}.pem`);
  const tmpKey = path.join(os.tmpdir(), `ipam-key-${Date.now()}.pem`);

  try {
    fs.writeFileSync(tmpCert, cert);
    fs.writeFileSync(tmpKey, key);

    // Validate certificate
    execSync(`openssl x509 -in "${tmpCert}" -noout`, { stdio: 'pipe', timeout: 5000 });

    // Validate key
    execSync(`openssl pkey -in "${tmpKey}" -noout`, { stdio: 'pipe', timeout: 5000 });

    // Verify key matches cert
    const certModulus = execSync(`openssl x509 -in "${tmpCert}" -noout -modulus`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const keyModulus = execSync(`openssl pkey -in "${tmpKey}" -noout -text 2>/dev/null | openssl rsa -modulus -noout 2>/dev/null || openssl pkey -in "${tmpKey}" -noout -text`, { encoding: 'utf-8', timeout: 5000 }).trim();

    // For RSA keys, modulus should match
    if (certModulus.startsWith('Modulus=') && keyModulus.startsWith('Modulus=') && certModulus !== keyModulus) {
      throw new Error('Certificate and key do not match');
    }

    // Install
    const certsDir = path.join(DATA_DIR, 'certs');
    fs.copyFileSync(tmpCert, path.join(certsDir, 'server.crt'));
    fs.copyFileSync(tmpKey, path.join(certsDir, 'server.key'));

    audit(req.user.id, 'update', 'tls_certificate', null, {});
    res.json({ ok: true, message: 'Certificate installed. Server restart required to apply.' });
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
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -nodes -subj "/CN=ipam/O=IPAM/C=US"`,
      { stdio: 'pipe', timeout: 10000 }
    );

    audit(req.user.id, 'update', 'tls_certificate', null, { action: 'reset_self_signed' });
    res.json({ ok: true, message: 'Self-signed certificate regenerated. Server restart required to apply.' });
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
    db.pragma('foreign_keys = OFF');
    const deleteAll = db.transaction(() => {
      for (const table of tables) {
        db.prepare(`DELETE FROM "${table}"`).run();
      }
    });
    deleteAll();
    db.pragma('foreign_keys = ON');

    // Re-seed system range types
    db.prepare(`INSERT INTO range_types (name, color, is_system, description) VALUES
      ('Network',   '#6b7280', 1, 'Network address (not assignable)'),
      ('Gateway',   '#f59e0b', 1, 'Default gateway address'),
      ('Broadcast', '#6b7280', 1, 'Broadcast address (not assignable)'),
      ('DHCP Pool', '#3b82f6', 1, 'Dynamic DHCP allocation pool'),
      ('Static',    '#10b981', 1, 'Statically assigned addresses')
    `).run();

    // Re-seed default folder
    db.prepare("INSERT INTO folders (name, description, sort_order) VALUES ('Default', 'Default folder', 0)").run();

    // Re-run ensureDefaults to recreate admin user, JWT secret, and default settings
    const { ensureDefaults } = await import('../db/init.js');
    await ensureDefaults();

    res.json({ ok: true, message: 'Database reset complete.' });
  } catch (err) {
    console.error('Database reset failed:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
