import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const TRACKING_FILE = path.join(DATA_DIR, '.cidrella-tracking.json');
const MAX_ENTRIES = 100;

function readTracking() {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeTracking(entries) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(entries, null, 2));
}

// GET — return all tracked interactions
router.get('/', (req, res) => {
  res.json(readTracking());
});

// POST — append new interactions
router.post('/', (req, res) => {
  const raw = Array.isArray(req.body) ? req.body : [req.body];
  const events = raw.filter(e => !(e.type === 'api' && (e.url?.includes('/dev/tracking') || e.url?.includes('/health/'))));
  if (events.length === 0) return res.json({ ok: true, count: 0 });
  const existing = readTracking();
  existing.push(...events);
  // Keep only the last MAX_ENTRIES
  const trimmed = existing.slice(-MAX_ENTRIES);
  writeTracking(trimmed);
  res.json({ ok: true, count: trimmed.length });
});

// DELETE — clear tracking data
router.delete('/', (req, res) => {
  writeTracking([]);
  res.json({ ok: true });
});

export default router;
