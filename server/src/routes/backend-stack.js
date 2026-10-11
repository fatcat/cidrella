import { Router } from 'express';
import { requireRole } from '../auth/roles.js';
import { STACKS, stackName } from '../backends/index.js';
import { audit, getDb } from '../db/init.js';
import {
  SwitchError,
  stackLabel,
  switchInProgress,
  switchPreflight,
  switchStack,
} from '../services/stack-switch.js';

// Settings > General > Servers: which stack serves DNS and DHCP (dnsmasq, or
// PowerDNS + Kea), and the switch to the other with the leases
// (services/stack-switch.js). Admin only: a switch stops DNS and DHCP for a
// few seconds.
const router = Router();

router.get('/', requireRole('admin'), (req, res) => {
  const current = stackName();
  const { stacks } = switchPreflight(current);
  res.json({
    current,
    label: stackLabel(current),
    switching: switchInProgress(),
    stacks,
    // What switching to each other stack would gain and lose.
    targets: Object.keys(STACKS)
      .filter((name) => name !== current)
      .map((name) => {
        const { blocked, gained, lost } = switchPreflight(name);
        return { name, label: stackLabel(name), blocked, gained, lost };
      }),
  });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const target = req.body?.stack;
  const names = Object.keys(STACKS);
  if (typeof target !== 'string' || !names.includes(target)) {
    return res.status(400).json({ error: `stack must be one of: ${names.join(', ')}` });
  }
  const from = stackName();
  try {
    const result = await switchStack(getDb(), target);
    audit(req.user.id, 'backend_stack_switched', 'setting', null, {
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
    audit(req.user.id, 'backend_stack_switch_failed', 'setting', null, {
      from,
      to: target,
      phase: err.phase,
      error: err.message,
      rolledBack: err.rolledBack,
      rollbackError: err.rollbackError,
    });
    const back = err.rolledBack
      ? err.rollbackError
        ? ` Putting ${stackLabel(from)} back also failed: ${err.rollbackError}`
        : ` ${stackLabel(from)} serves DNS and DHCP again.`
      : '';
    res.status(500).json({
      error: `The switch to ${stackLabel(target)} stopped (${err.phase}): ${err.message}.${back}`,
      phase: err.phase,
      rolledBack: err.rolledBack,
    });
  }
});

export default router;
