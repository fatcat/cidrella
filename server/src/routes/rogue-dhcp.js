import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { isValidIpv4, isValidMac } from '../utils/ip.js';
import { runProbe, getProbeState } from '../utils/dhcp-probe.js';
import * as RogueDhcp from '../models/rogue-dhcp.js';

const router = Router();

// GET /api/dhcp/rogue/status
router.get('/status', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const { lastProbeAt, probeSupported, probeInProgress, lastProbeOutcome, lastProbeError } = getProbeState();
  const enabled = getSetting('rogue_dhcp_detection_enabled') === 'true';
  const intervalMin = parseInt(getSetting('rogue_dhcp_probe_interval_min'), 10) || 15;

  // Detection is only doing its job if it is actually probing. A clean probe
  // logs nothing, and the one routine log line it does emit only appears when a
  // rogue is found, so "healthy on a quiet network" and "has not run in weeks"
  // look identical from outside. Report the difference directly.
  const graceMs = (intervalMin * 60 * 1000) * 2 + 60 * 1000;
  // lastProbeAt is per-process, so it is null for the first few seconds after
  // every restart. Give the scheduler's initial kick room to land rather than
  // showing "nothing is watching" on each start, which would train the operator
  // to ignore the one banner that matters.
  const NEVER_PROBED_GRACE_MS = 2 * 60 * 1000;
  const ageMs = lastProbeAt ? Date.now() - new Date(lastProbeAt).getTime() : null;
  const stale = enabled && probeSupported && (
    ageMs === null ? process.uptime() * 1000 > NEVER_PROBED_GRACE_MS : ageMs > graceMs
  );

  res.json({
    enabled,
    intervalMin,
    lastProbeAt,
    probeSupported,
    probeInProgress,
    lastProbeOutcome,
    lastProbeError,
    healthy: !enabled || (probeSupported && !stale),
    stale,
    unacknowledged: RogueDhcp.countUnacknowledged(db),
  });
});

// GET /api/dhcp/rogue/events
router.get('/events', requirePerm('dhcp:read'), (req, res) => {
  res.json(RogueDhcp.listEvents(getDb()));
});

// POST /api/dhcp/rogue/events/:id/acknowledge
router.post('/events/:id/acknowledge', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const result = RogueDhcp.acknowledgeEvent(db, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Event not found' });
  audit(req.user.id, 'rogue_dhcp_acknowledged', 'rogue_dhcp_event', req.params.id, {});
  res.json({ ok: true });
});

// POST /api/dhcp/rogue/acknowledge-all
router.post('/acknowledge-all', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const result = RogueDhcp.acknowledgeAll(db);
  audit(req.user.id, 'rogue_dhcp_acknowledged_all', 'rogue_dhcp_event', null, { count: result.changes });
  res.json({ ok: true, acknowledged: result.changes });
});

// DELETE /api/dhcp/rogue/events/:id
router.delete('/events/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const result = RogueDhcp.clearEvent(db, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Event not found' });
  audit(req.user.id, 'rogue_dhcp_cleared', 'rogue_dhcp_event', req.params.id, {});
  res.json({ ok: true });
});

// POST /api/dhcp/rogue/probe: trigger an immediate probe
router.post('/probe', requirePerm('dhcp:write'), async (req, res) => {
  let summary;
  try {
    summary = await runProbe(getDb(), {});
  } catch (err) {
    // runProbe rejects when it cannot even get as far as opening a socket.
    // Name the failure instead of letting it surface as a bare 500.
    return res.status(500).json({ error: `DHCP probe could not start: ${err.message}` });
  }
  audit(req.user.id, 'rogue_dhcp_probe', 'rogue_dhcp', null, {
    interfaces: summary.interfaces, offers: summary.offers,
    rogues: summary.rogues.length, skipped: summary.skipped === true,
  });
  res.json({
    supported: summary.supported,
    // A skipped run finds nothing because it never looked. Reporting that as a
    // successful probe with zero results is how a dead prober stays hidden.
    skipped: summary.skipped === true,
    skipReason: summary.skipReason ?? null,
    interfaces: summary.interfaces,
    offers: summary.offers,
    rogueCount: summary.rogues.length,
  });
});

// ─── Authorized-server allowlist ─────────────────────────

// GET /api/dhcp/rogue/authorized
router.get('/authorized', requirePerm('dhcp:read'), (req, res) => {
  res.json(RogueDhcp.listAuthorized(getDb()));
});

// POST /api/dhcp/rogue/authorized
router.post('/authorized', requirePerm('dhcp:write'), (req, res) => {
  const { server_ip, server_mac, description } = req.body || {};
  if (!server_ip || !isValidIpv4(server_ip)) {
    return res.status(400).json({ error: 'A valid IPv4 server_ip is required' });
  }
  if (server_mac && !isValidMac(server_mac)) {
    return res.status(400).json({ error: 'server_mac is not a valid MAC address' });
  }
  if (description != null && (typeof description !== 'string' || description.length > 256)) {
    return res.status(400).json({ error: 'description must be a string up to 256 chars' });
  }
  const db = getDb();
  const result = RogueDhcp.addAuthorized(db, { server_ip, server_mac, description });
  if (result.changes === 0) {
    return res.status(409).json({ error: 'That server IP is already authorized' });
  }
  audit(req.user.id, 'rogue_dhcp_authorized_added', 'dhcp_authorized_server', result.lastInsertRowid, { server_ip });
  res.status(201).json({ id: result.lastInsertRowid });
});

// DELETE /api/dhcp/rogue/authorized/:id
router.delete('/authorized/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM dhcp_authorized_servers WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  RogueDhcp.deleteAuthorized(db, req.params.id);
  audit(req.user.id, 'rogue_dhcp_authorized_removed', 'dhcp_authorized_server', req.params.id, { server_ip: entry.server_ip });
  res.json({ ok: true });
});

// ─── Settings ────────────────────────────────────────────

// PUT /api/dhcp/rogue/settings
router.put('/settings', requirePerm('dhcp:write'), (req, res) => {
  const { enabled, intervalMin } = req.body || {};

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (intervalMin !== undefined) {
    const n = Number(intervalMin);
    if (!Number.isInteger(n) || n < 5 || n > 1440) {
      return res.status(400).json({ error: 'intervalMin must be an integer 5-1440' });
    }
  }

  if (enabled !== undefined) setSetting('rogue_dhcp_detection_enabled', enabled ? 'true' : 'false');
  if (intervalMin !== undefined) setSetting('rogue_dhcp_probe_interval_min', String(intervalMin));

  audit(req.user.id, 'rogue_dhcp_settings_updated', 'rogue_dhcp', null, { enabled, intervalMin });
  res.json({
    enabled: getSetting('rogue_dhcp_detection_enabled') === 'true',
    intervalMin: parseInt(getSetting('rogue_dhcp_probe_interval_min'), 10) || 15,
  });
});

export default router;
