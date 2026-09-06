import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { isValidMac } from '../utils/ip.js';
import * as DeviceFingerprint from '../models/device-fingerprint.js';

const router = Router();

// GET /api/devices/:mac/fingerprint: full per-device fingerprint (for the
// host "more info" popup). Returns null fields when unknown.
router.get('/:mac/fingerprint', requirePerm('dhcp:read'), (req, res) => {
  const mac = req.params.mac;
  if (!isValidMac(mac)) return res.status(400).json({ error: 'Invalid MAC address' });
  const row = DeviceFingerprint.getByMac(getDb(), mac);
  res.json(row || { mac_address: mac.toLowerCase(), device_type: null, os_family: null, confidence: 0, source: null });
});

// GET /api/devices/:mac/fingerprint/history: recent device_type/os_family/
// vendor_class drift for this MAC -- e.g. a "Samsung/IoT" device suddenly
// classifying as generic Linux, which can indicate MAC spoofing or a rogue
// device taking over a trusted address.
router.get('/:mac/fingerprint/history', requirePerm('dhcp:read'), (req, res) => {
  const mac = req.params.mac;
  if (!isValidMac(mac)) return res.status(400).json({ error: 'Invalid MAC address' });
  const days = parseInt(req.query.days, 10) || 90;
  res.json(DeviceFingerprint.getFingerprintChanges(getDb(), mac, days));
});

// PUT /api/devices/:mac/fingerprint: operator override of device type / OS.
router.put('/:mac/fingerprint', requirePerm('dhcp:write'), (req, res) => {
  const mac = req.params.mac;
  if (!isValidMac(mac)) return res.status(400).json({ error: 'Invalid MAC address' });
  const { device_type, os_family } = req.body || {};
  if (device_type != null && (typeof device_type !== 'string' || device_type.length > 64)) {
    return res.status(400).json({ error: 'device_type must be a string up to 64 chars' });
  }
  if (os_family != null && (typeof os_family !== 'string' || os_family.length > 64)) {
    return res.status(400).json({ error: 'os_family must be a string up to 64 chars' });
  }
  const db = getDb();
  DeviceFingerprint.setManual(db, mac, { device_type, os_family });
  audit(req.user.id, 'device_fingerprint_override', 'device_fingerprint', null, { mac: mac.toLowerCase(), device_type, os_family });
  res.json(DeviceFingerprint.getByMac(db, mac));
});

// DELETE /api/devices/:mac/fingerprint: remove an operator override so the
// device goes back to auto-classification on its next DHCP transaction.
// No-op (still 200) when the row isn't a manual override.
router.delete('/:mac/fingerprint', requirePerm('dhcp:write'), (req, res) => {
  const mac = req.params.mac;
  if (!isValidMac(mac)) return res.status(400).json({ error: 'Invalid MAC address' });
  const db = getDb();
  const info = DeviceFingerprint.clearManual(db, mac);
  if (info.changes > 0) {
    audit(req.user.id, 'device_fingerprint_reset', 'device_fingerprint', null, { mac: mac.toLowerCase() });
  }
  res.json({ ok: true, cleared: info.changes > 0 });
});

export default router;
