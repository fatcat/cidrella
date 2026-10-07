import { Router } from 'express';
import { featureReport } from '../backends/index.js';
import { ipv6Enabled } from '../utils/ipv6-support.js';

// GET /api/features: the switches the UI needs before it renders anything.
// Any signed-in user may read it; a viewer hides the same IPv6 affordances an
// admin does. `backendFeatures` lists every backend-dependent feature with
// whether the active backend supports it and why not (backends/features.js).
const router = Router();

router.get('/', (req, res) => {
  res.json({ ipv6: ipv6Enabled(), backendFeatures: featureReport() });
});

export default router;
