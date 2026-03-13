import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { startScan } from '../utils/scanner.js';
import { getNextScanTime } from '../utils/scan-scheduler.js';
import { MAX_SCAN_SIZE } from '../config/defaults.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/scans — list scans (optionally filtered by subnet_id)
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const { subnet_id } = req.query;

  let query = `
    SELECT ns.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM network_scans ns
    JOIN subnets sub ON ns.subnet_id = sub.id
  `;
  const params = [];

  if (subnet_id) {
    query += ' WHERE ns.subnet_id = ?';
    params.push(subnet_id);
  }

  query += ' ORDER BY ns.created_at DESC LIMIT 50';
  res.json(db.prepare(query).all(...params));
});

// GET /api/scans/next — next scheduled scan time
router.get('/next', requirePerm('subnets:read'), (req, res) => {
  res.json({ next_scan_at: getNextScanTime() });
});

// GET /api/scans/:id — get scan with results
router.get('/:id', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const scan = db.prepare(`
    SELECT ns.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM network_scans ns
    JOIN subnets sub ON ns.subnet_id = sub.id
    WHERE ns.id = ?
  `).get(req.params.id);

  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const results = db.prepare(`
    SELECT * FROM scan_results WHERE scan_id = ? ORDER BY ip_address
  `).all(scan.id);

  res.json({ ...scan, results });
});

// POST /api/scans — start a new scan
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { subnet_id } = req.body;
  const db = getDb();

  if (!subnet_id) return res.status(400).json({ error: 'subnet_id is required' });

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet_id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
  if (subnet.status !== 'allocated') {
    return res.status(400).json({ error: 'Can only scan allocated subnets' });
  }

  // Check if there's already a running scan for this subnet
  const running = db.prepare("SELECT id FROM network_scans WHERE subnet_id = ? AND status IN ('pending', 'running')").get(subnet_id);
  if (running) {
    return res.status(409).json({ error: 'A scan is already in progress for this subnet', scan_id: running.id });
  }

  // Limit scan size to prevent excessive load
  if (subnet.total_addresses > MAX_SCAN_SIZE) {
    return res.status(400).json({ error: `Subnet too large for scanning (max ${MAX_SCAN_SIZE} IPs)` });
  }

  const result = db.prepare("INSERT INTO network_scans (subnet_id, status) VALUES (?, 'pending')").run(subnet_id);
  const scanId = result.lastInsertRowid;

  // Start scan in background (don't await)
  startScan(db, scanId, subnet_id);

  audit(req.user.id, 'scan_started', 'network_scan', scanId, { subnet: subnet.cidr });

  const scan = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(scanId);
  res.status(201).json(scan);
});

// DELETE /api/scans/:id — delete scan and results
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const scan = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  // Don't delete running scans
  if (scan.status === 'running') {
    return res.status(409).json({ error: 'Cannot delete a running scan' });
  }

  db.prepare('DELETE FROM network_scans WHERE id = ?').run(scan.id);
  res.json({ message: 'Scan deleted' });
});

export default router;
