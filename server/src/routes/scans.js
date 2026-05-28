import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { startScan } from '../utils/scanner.js';
import { getNextScanTime } from '../utils/scan-scheduler.js';
import { isIpInSubnet, isValidIpv4 } from '../utils/ip.js';
import { MAX_SCAN_SIZE } from '../config/defaults.js';
import * as ScanRun from '../models/scan-run.js';

const router = Router();

// GET /api/scans — list scans (optionally filtered by subnet_id)
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const { subnet_id } = req.query;
  res.json(ScanRun.list(db, { subnetId: subnet_id || null }));
});

// GET /api/scans/next — next scheduled scan time
router.get('/next', requirePerm('subnets:read'), (req, res) => {
  res.json({ next_scan_at: getNextScanTime() });
});

// GET /api/scans/:id — get scan with results
router.get('/:id', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const scan = ScanRun.findById(db, req.params.id);

  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const results = ScanRun.getResults(db, scan.id);

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

  // Limit scan size to prevent excessive load
  if (subnet.total_addresses > MAX_SCAN_SIZE) {
    return res.status(400).json({ error: `Subnet too large for scanning (max ${MAX_SCAN_SIZE} IPs)` });
  }

  const pending = ScanRun.createPendingIfIdle(db, subnet_id);
  if (!pending.created) {
    return res.status(409).json({ error: 'A scan is already in progress for this subnet', scan_id: pending.scanId });
  }
  const scanId = pending.scanId;

  // Start scan in background (don't await)
  startScan(db, scanId, subnet_id);

  audit(req.user.id, 'scan_started', 'network_scan', scanId, { subnet: subnet.cidr });

  const scan = ScanRun.findById(db, scanId);
  res.status(201).json(scan);
});

// POST /api/scans/probe — probe a single IP (or list) for liveness using startScan
router.post('/probe', requirePerm('subnets:write'), async (req, res) => {
  const { ip, subnet_id } = req.body;
  if (!ip || !isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Valid IP address is required' });
  }

  const db = getDb();

  // Find the subnet — either from explicit subnet_id or by searching
  let resolvedSubnetId = subnet_id;
  if (resolvedSubnetId) {
    const subnet = db.prepare("SELECT id, cidr, status FROM subnets WHERE id = ?").get(resolvedSubnetId);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    if (subnet.status !== 'allocated') {
      return res.status(400).json({ error: 'Can only probe allocated subnets' });
    }
    if (!isIpInSubnet(ip, subnet.cidr)) {
      return res.status(400).json({ error: 'IP address is not in the selected subnet' });
    }
  } else {
    const subnets = db.prepare("SELECT id, cidr FROM subnets WHERE status = 'allocated'").all();
    for (const s of subnets) {
      if (isIpInSubnet(ip, s.cidr)) { resolvedSubnetId = s.id; break; }
    }
  }
  if (!resolvedSubnetId) {
    return res.status(404).json({ error: 'No matching subnet found for this IP' });
  }

  try {
    // Create a scan record for this targeted probe
    const scanId = ScanRun.createPending(db, resolvedSubnetId);

    // Run the scan synchronously with targeted IP
    const scanResult = await startScan(db, scanId, resolvedSubnetId, { targetIps: [ip] });

    // Read the scan result for this IP
    const sr = ScanRun.getResultForIp(db, scanId, ip);

    // Clean up the probe scan record (don't clutter scan history)
    ScanRun.deleteById(db, scanId);

    if (!sr) {
      return res.status(500).json({ error: 'Probe completed but no result recorded' });
    }

    res.json({
      ip,
      responded: !!sr.responded,
      mac: sr.mac_address,
      method: scanResult?.results?.[ip] || scanResult?.method || 'unknown',
      is_conflict: !!sr.is_conflict,
      conflict_reason: sr.conflict_reason
    });
  } catch (err) {
    res.status(500).json({ error: `Probe failed: ${err.message}` });
  }
});

// DELETE /api/scans/:id — delete scan and results
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const result = ScanRun.deleteIfNotRunning(db, req.params.id);
  if (result.missing) return res.status(404).json({ error: 'Scan not found' });
  if (result.running) {
    return res.status(409).json({ error: 'Cannot delete a running scan' });
  }

  res.json({ message: 'Scan deleted' });
});

export default router;
