import { Router } from 'express';
import { ipv6Enabled } from '../utils/ipv6-support.js';

// GET /api/features: the switches the UI needs before it renders anything.
// Any signed-in user may read it; a viewer hides the same IPv6 affordances an
// admin does.
const router = Router();

router.get('/', (req, res) => {
  res.json({ ipv6: ipv6Enabled() });
});

export default router;
