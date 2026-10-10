import { Router } from 'express';
import { requireRole } from '../auth/roles.js';
import { DHCP_BACKENDS, dhcpBackendName } from '../backends/index.js';
import { audit, getDb } from '../db/init.js';
import {
  SwitchError,
  backendLabel,
  switchDhcpBackend,
  switchInProgress,
  switchPreflight,
} from '../services/dhcp-backend-switch.js';

// Settings > DHCP > Server: which backend serves DHCP, and the switch to the
// other one with its leases (services/dhcp-backend-switch.js). Admin only:
// a switch stops DHCP for a moment and restarts the DNS server.
const router = Router();

router.get('/', requireRole('admin'), (req, res) => {
  const current = dhcpBackendName();
  res.json({
    current,
    label: backendLabel(current),
    switching: switchInProgress(),
    // What switching to each other backend would gain and lose.
    targets: DHCP_BACKENDS.filter((name) => name !== current).map((name) => ({
      name,
      label: backendLabel(name),
      ...switchPreflight(name),
    })),
  });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const target = req.body?.target;
  if (typeof target !== 'string' || !DHCP_BACKENDS.includes(target)) {
    return res.status(400).json({ error: `target must be one of: ${DHCP_BACKENDS.join(', ')}` });
  }
  const from = dhcpBackendName();
  try {
    const result = await switchDhcpBackend(getDb(), target);
    audit(req.user.id, 'dhcp_backend_switched', 'setting', null, {
      from,
      to: target,
      leases: result.leases,
      refused: result.failed.length,
      missing: result.missing.length,
    });
    res.json(result);
  } catch (err) {
    if (!(err instanceof SwitchError)) throw err;
    if (err.phase === 'preflight') return res.status(409).json({ error: err.message });
    audit(req.user.id, 'dhcp_backend_switch_failed', 'setting', null, {
      from,
      to: target,
      phase: err.phase,
      error: err.message,
      rolledBack: err.rolledBack,
      rollbackError: err.rollbackError,
    });
    const back = err.rolledBack
      ? err.rollbackError
        ? ` Putting ${backendLabel(from)} back also failed: ${err.rollbackError}`
        : ` ${backendLabel(from)} serves DHCP again.`
      : '';
    res.status(500).json({
      error: `The switch to ${backendLabel(target)} stopped (${err.phase}): ${err.message}.${back}`,
      phase: err.phase,
      rolledBack: err.rolledBack,
    });
  }
});

export default router;
